// decay.mjs — Weight decay and pruning
import { retryOnBusy } from './retry.mjs';

/**
 * Run decay pass on all non-pinned nodes.
 * Decay formula: new_weight = weight * (0.98 ^ hours_since_access)
 *   ~61% after 1 day, ~23% after 3 days, faded at ~4.7 days
 *
 * @param {Graph} graph
 * @param {Database} db
 * @param {object} opts
 * @param {number} opts.decayBase - Base of exponential decay (default 0.98)
 * @param {number} opts.fadeThreshold - Below this → faded (default 0.1)
 * @param {number} opts.pruneThreshold - Below this + low access → prune candidate (default 0.01)
 * @param {number} opts.pruneMinAccess - Min access_count to survive prune threshold (default 3)
 * @returns {{ decayed: number, faded: string[], pruned: string[] }}
 */
export function runDecay(graph, db, opts = {}) {
  const {
    fadeThreshold = 0.1,
    pruneThreshold = 0.01,
    pruneMinAccess = 3
  } = opts;

  // Per-type decay rates: lower = faster decay
  const decayRates = {
    event: 0.98,       // temporal — ~61% after 1 day, gone in ~5 days
    task: 0.98,        // temporal — same as events
    concept: 0.995,    // ideas persist — ~89% after 1 day, ~70% after 30 days
    lesson: 0.995,     // learned things persist
    decision: 0.997,   // decisions persist longer — ~93% after 1 day
    impression: 0.995, // subjective responses persist like concepts
    entity: 0.998,     // people/systems persist — ~95% after 1 day
    'behavioral-principle': 0.999,  // standing principles — slow decay
    'topical-principle': 0.999,     // standing principles — slow decay
    preference: 1.0,   // user preferences — no decay
    'held-contradiction': 0.999, // persists — slow decay like principles
    problem: 0.995,    // unresolved issues persist like concepts
  };
  const defaultDecayBase = 0.98;

  const now = Date.now();
  let decayed = 0;
  const faded = [];
  const pruned = [];

  // Prepare bulk update
  const updateStmt = db.prepare('UPDATE nodes SET weight = ?, updated_at = ? WHERE id = ?');
  const pruneStmt = db.prepare('INSERT OR REPLACE INTO pruned_nodes (id, data, pruned_at) VALUES (?, ?, ?)');
  const deleteEdgesStmt = db.prepare('DELETE FROM edges WHERE source = ? OR target = ?');
  const deleteNodeStmt = db.prepare('DELETE FROM nodes WHERE id = ?');

  const toPrune = [];

  // Pre-compute superseded nodes (nodes with incoming 'supersedes' edges decay faster)
  const supersededNodes = new Set();
  try {
    const supersededRows = db.prepare("SELECT target FROM edges WHERE type = 'supersedes'").all();
    for (const row of supersededRows) supersededNodes.add(row.target);
  } catch { /* edges table might not have supersedes rows yet */ }

  // Pre-compute isolated old nodes (>14 days, zero outgoing edges → 2x decay)
  const isolatedOldNodes = new Set();
  const fourteenDaysMs = 14 * 24 * 3600000;
  try {
    const allSources = new Set(db.prepare("SELECT DISTINCT source FROM edges").all().map(r => r.source));
    graph.forEachNode((nodeId, attrs) => {
      if (attrs.pinned) return;
      const age = now - (attrs.created_at || now);
      if (age > fourteenDaysMs && !allSources.has(nodeId)) {
        isolatedOldNodes.add(nodeId);
      }
    });
  } catch { /* edges table might be empty */ }

  graph.forEachNode((nodeId, attrs) => {
    if (attrs.pinned) return;

    const hoursSinceAccess = (now - (attrs.last_accessed || attrs.created_at)) / 3600000;
    let decayBase = decayRates[attrs.type] || defaultDecayBase;
    // Done tasks are scaffolding — prune immediately (learnings live in other node types)
    if (attrs.type === 'task' && attrs.status === 'done') {
      toPrune.push(nodeId);
      return;
    }
    // Superseded nodes decay at squared rate (~3x faster effective decay)
    if (supersededNodes.has(nodeId)) decayBase = decayBase * decayBase;
    // Isolated old nodes (>14 days, no outgoing edges) decay at squared rate
    if (isolatedOldNodes.has(nodeId)) decayBase = decayBase * decayBase;
    const decayFactor = Math.pow(decayBase, hoursSinceAccess);
    // decayFactor is the absolute target weight (decayBase^hours from 1.0)
    // Don't multiply by current weight — that compounds decay across runs
    const newWeight = decayFactor;

    if (newWeight !== attrs.weight) {
      graph.setNodeAttribute(nodeId, 'weight', newWeight);
      retryOnBusy(() => updateStmt.run(newWeight, now, nodeId));
      decayed++;
    }

    // Type-aware pruning: events prune at fadeThreshold (0.1), others at pruneThreshold (0.01)
    // No access_count gate — it created a feedback loop where stale search hits survived forever
    const effectivePruneThreshold = (attrs.type === 'event' || attrs.type === 'task') ? fadeThreshold : pruneThreshold;
    if (newWeight < effectivePruneThreshold) {
      toPrune.push(nodeId);
    } else if (newWeight < fadeThreshold) {
      faded.push(nodeId);
    }
  });

  // Prune in transaction
  if (toPrune.length > 0) {
    const pruneTx = db.transaction(() => {
      for (const nodeId of toPrune) {
        const data = JSON.stringify(graph.getNodeAttributes(nodeId));
        pruneStmt.run(nodeId, data, now);
        deleteEdgesStmt.run(nodeId, nodeId);
        deleteNodeStmt.run(nodeId);
        graph.dropNode(nodeId);
        pruned.push(nodeId);
      }
    });
    retryOnBusy(() => pruneTx());
  }

  return { decayed, faded, pruned };
}

/**
 * Boost a node's weight (on access or new edge).
 * @param {Graph} graph
 * @param {Database} db
 * @param {string} nodeId
 * @param {number} boost - Amount to boost (default 0.2)
 */
/**
 * Suppress a node's weight (retrieval near-miss penalty).
 * Unlike boost, does NOT update last_accessed or access_count.
 * @param {Graph} graph
 * @param {Database} db
 * @param {string} nodeId
 * @param {number} penalty - Amount to subtract (default 0.02)
 */
export function suppressWeight(graph, db, nodeId, penalty = 0.02) {
  if (!graph.hasNode(nodeId)) return;
  const attrs = graph.getNodeAttributes(nodeId);
  if (attrs.pinned) return; // don't suppress pinned nodes
  const current = attrs.weight || 0;
  const newWeight = Math.max(0, current - penalty);
  const now = Date.now();

  graph.setNodeAttribute(nodeId, 'weight', newWeight);

  retryOnBusy(() =>
    db.prepare('UPDATE nodes SET weight = ?, updated_at = ? WHERE id = ?')
      .run(newWeight, now, nodeId)
  );
}

export function boostWeight(graph, db, nodeId, boost = 0.2) {
  if (!graph.hasNode(nodeId)) return;
  const current = graph.getNodeAttribute(nodeId, 'weight') || 0;
  const newWeight = Math.min(1.0, current + boost);
  const now = Date.now();

  graph.setNodeAttribute(nodeId, 'weight', newWeight);
  graph.setNodeAttribute(nodeId, 'last_accessed', now);
  graph.updateNodeAttribute(nodeId, 'access_count', c => (c || 0) + 1);

  retryOnBusy(() =>
    db.prepare('UPDATE nodes SET weight = ?, last_accessed = ?, access_count = access_count + 1, updated_at = ? WHERE id = ?')
      .run(newWeight, now, now, nodeId)
  );
}
