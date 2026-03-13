// analyze.mjs — Graph analysis for self-knowledge

/**
 * Compute degree centrality for all nodes.
 * @param {Graph} graph
 * @returns {Array<{ id: string, degree: number, name: string, type: string }>}
 */
export function degreeCentrality(graph) {
  const results = [];
  graph.forEachNode((id, attrs) => {
    results.push({
      id,
      degree: graph.degree(id),
      name: attrs.name,
      type: attrs.type
    });
  });
  results.sort((a, b) => b.degree - a.degree);
  return results;
}

/**
 * Simple community detection via connected components on strongly-connected subsets.
 * Groups nodes that share edges.
 * @param {Graph} graph
 * @returns {Map<number, string[]>} community index → node ids
 */
export function detectCommunities(graph) {
  const visited = new Set();
  const communities = new Map();
  let communityId = 0;

  graph.forEachNode((startId) => {
    if (visited.has(startId)) return;

    // BFS from this node
    const community = [];
    const queue = [startId];
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      community.push(current);

      graph.forEachNeighbor(current, (neighborId) => {
        if (!visited.has(neighborId)) queue.push(neighborId);
      });
    }

    communities.set(communityId++, community);
  });

  return communities;
}

/**
 * Find orphan nodes (no edges).
 * @param {Graph} graph
 * @returns {Array<{ id: string, name: string, type: string, weight: number }>}
 */
export function findOrphans(graph) {
  const orphans = [];
  graph.forEachNode((id, attrs) => {
    if (graph.degree(id) === 0) {
      orphans.push({ id, name: attrs.name, type: attrs.type, weight: attrs.weight });
    }
  });
  return orphans;
}

/**
 * Temporal analysis — nodes created per day.
 * @param {Graph} graph
 * @param {number} days - How many days back to analyze (default 30)
 * @returns {Map<string, number>} date string → count
 */
export function temporalAnalysis(graph, days = 30) {
  const cutoff = Date.now() - (days * 86400000);
  const counts = new Map();

  graph.forEachNode((id, attrs) => {
    if (attrs.created_at < cutoff) return;
    const date = new Date(attrs.created_at).toISOString().slice(0, 10);
    counts.set(date, (counts.get(date) || 0) + 1);
  });

  return counts;
}

/**
 * Decay report — what's fading and what's strong.
 * @param {Graph} graph
 * @returns {{ strong: Array, fading: Array, faded: Array }}
 */
export function decayReport(graph) {
  const strong = [];  // weight > 0.5
  const fading = [];  // 0.1 - 0.5
  const faded = [];   // < 0.1

  graph.forEachNode((id, attrs) => {
    if (attrs.pinned) return;
    const entry = { id, name: attrs.name, type: attrs.type, weight: attrs.weight, access_count: attrs.access_count };
    if (attrs.weight > 0.5) strong.push(entry);
    else if (attrs.weight >= 0.1) fading.push(entry);
    else faded.push(entry);
  });

  strong.sort((a, b) => b.weight - a.weight);
  fading.sort((a, b) => a.weight - b.weight);
  faded.sort((a, b) => a.weight - b.weight);

  return { strong, fading, faded };
}

/**
 * Generate a human-readable graph report.
 * @param {Graph} graph
 * @returns {string}
 */
export function generateReport(graph) {
  const lines = ['# Graph Memory Report', `Generated: ${new Date().toISOString()}`, ''];

  // Stats
  lines.push(`## Stats`);
  lines.push(`- Nodes: ${graph.order}`);
  lines.push(`- Edges: ${graph.size}`);

  // Type distribution
  const typeCounts = {};
  graph.forEachNode((_, attrs) => {
    typeCounts[attrs.type] = (typeCounts[attrs.type] || 0) + 1;
  });
  lines.push(`- Types: ${Object.entries(typeCounts).map(([t, c]) => `${t}(${c})`).join(', ')}`);
  lines.push('');

  // Top by degree
  const top = degreeCentrality(graph).slice(0, 10);
  if (top.length) {
    lines.push('## Most Connected');
    for (const n of top) {
      lines.push(`- ${n.name} [${n.type}] — ${n.degree} connections`);
    }
    lines.push('');
  }

  // Orphans
  const orphans = findOrphans(graph);
  if (orphans.length) {
    lines.push(`## Orphan Nodes (${orphans.length})`);
    for (const o of orphans.slice(0, 10)) {
      lines.push(`- ${o.name} [${o.type}] — weight: ${o.weight.toFixed(2)}`);
    }
    if (orphans.length > 10) lines.push(`  ... and ${orphans.length - 10} more`);
    lines.push('');
  }

  // Decay
  const decay = decayReport(graph);
  lines.push(`## Health`);
  lines.push(`- Strong (>0.5): ${decay.strong.length}`);
  lines.push(`- Fading (0.1-0.5): ${decay.fading.length}`);
  lines.push(`- Faded (<0.1): ${decay.faded.length}`);

  return lines.join('\n');
}
