// persistence.mjs — SQLite ↔ Graphology sync
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
import Graph from 'graphology';
import { createNode, createEdge } from './schema.mjs';
import { retryOnBusy } from './retry.mjs';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const SCHEMA_VERSION = 1;

/**
 * Initialize the SQLite database with schema.
 */
function initDB(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  // WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  // Wait up to 30 seconds if another process holds the lock (prevents SQLITE_BUSY)
  // Increased from 5s to support parallel heartbeat workers
  db.pragma('busy_timeout = 30000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT DEFAULT '',
      source TEXT DEFAULT 'unknown',
      trust TEXT DEFAULT 'direct',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL,
      access_count INTEGER DEFAULT 0,
      weight REAL DEFAULT 1.0,
      pinned INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      status TEXT DEFAULT NULL,
      schedule TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS edges (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      type TEXT NOT NULL,
      subtype TEXT DEFAULT NULL,
      context TEXT DEFAULT '',
      weight REAL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      valid_from INTEGER DEFAULT NULL,
      valid_until INTEGER DEFAULT NULL,
      PRIMARY KEY (source, target, type),
      FOREIGN KEY (source) REFERENCES nodes(id),
      FOREIGN KEY (target) REFERENCES nodes(id)
    );

    CREATE TABLE IF NOT EXISTS pruned_nodes (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      pruned_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
    CREATE INDEX IF NOT EXISTS idx_nodes_weight ON nodes(weight);
    CREATE INDEX IF NOT EXISTS idx_nodes_pinned ON nodes(pinned);
    CREATE INDEX IF NOT EXISTS idx_nodes_last_accessed ON nodes(last_accessed);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
    CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
  `);

  // Migrations — add columns if they don't exist (idempotent)
  const edgeCols = db.prepare("PRAGMA table_info(edges)").all().map(c => c.name);
  if (!edgeCols.includes('subtype')) {
    db.exec('ALTER TABLE edges ADD COLUMN subtype TEXT DEFAULT NULL');
  }
  if (!edgeCols.includes('valid_from')) {
    db.exec('ALTER TABLE edges ADD COLUMN valid_from INTEGER DEFAULT NULL');
  }
  if (!edgeCols.includes('valid_until')) {
    db.exec('ALTER TABLE edges ADD COLUMN valid_until INTEGER DEFAULT NULL');
  }

  const nodeCols = db.prepare("PRAGMA table_info(nodes)").all().map(c => c.name);
  if (!nodeCols.includes('embedding')) {
    db.exec('ALTER TABLE nodes ADD COLUMN embedding BLOB DEFAULT NULL');
  }
  if (!nodeCols.includes('helpful_count')) {
    db.exec('ALTER TABLE nodes ADD COLUMN helpful_count INTEGER DEFAULT 0');
  }
  if (!nodeCols.includes('harmful_count')) {
    db.exec('ALTER TABLE nodes ADD COLUMN harmful_count INTEGER DEFAULT 0');
  }

  // --- FTS5 full-text search index ---
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      id UNINDEXED,
      name,
      content,
      type UNINDEXED,
      content='nodes',
      content_rowid='rowid',
      tokenize='porter ascii'
    );

    -- Triggers to keep FTS in sync with nodes table
    CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, id, name, content, type)
      VALUES (new.rowid, new.id, new.name, new.content, new.type);
    END;

    CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, id, name, content, type)
      VALUES ('delete', old.rowid, old.id, old.name, old.content, old.type);
    END;

    CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, id, name, content, type)
      VALUES ('delete', old.rowid, old.id, old.name, old.content, old.type);
      INSERT INTO nodes_fts(rowid, id, name, content, type)
      VALUES (new.rowid, new.id, new.name, new.content, new.type);
    END;
  `);

  // Rebuild FTS index if out of sync (first run or after external changes)
  const ftsCount = db.prepare('SELECT COUNT(*) as c FROM nodes_fts').get().c;
  const nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
  if (ftsCount !== nodeCount) {
    db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
  }

  // Set schema version
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));

  return db;
}

/**
 * Load entire graph from SQLite into Graphology.
 * @param {string} dbPath
 * @returns {{ graph: Graph, db: Database }}
 */
export function loadGraph(dbPath) {
  const db = initDB(dbPath);
  const graph = new Graph({ multi: true });

  // Load nodes
  const nodes = db.prepare('SELECT * FROM nodes').all();
  for (const row of nodes) {
    graph.addNode(row.id, {
      ...row,
      pinned: !!row.pinned,
      tags: JSON.parse(row.tags || '[]')
    });
  }

  // Load edges
  const edges = db.prepare('SELECT * FROM edges').all();
  for (const row of edges) {
    // Skip edges pointing to missing nodes (defensive)
    if (!graph.hasNode(row.source) || !graph.hasNode(row.target)) continue;
    const key = `${row.source}→${row.target}:${row.type}`;
    graph.addEdgeWithKey(key, row.source, row.target, {
      type: row.type,
      subtype: row.subtype || null,
      context: row.context,
      weight: row.weight,
      created_at: row.created_at,
      valid_from: row.valid_from || null,
      valid_until: row.valid_until || null
    });
  }

  return { graph, db };
}

// --- Prepared statement cache ---
const stmtCache = new WeakMap();

function getStmts(db) {
  if (stmtCache.has(db)) return stmtCache.get(db);
  const stmts = {
    upsertNode: db.prepare(`
      INSERT OR REPLACE INTO nodes (id, type, name, content, source, trust, created_at, updated_at, last_accessed, access_count, weight, pinned, tags, status, schedule, helpful_count, harmful_count)
      VALUES (@id, @type, @name, @content, @source, @trust, @created_at, @updated_at, @last_accessed, @access_count, @weight, @pinned, @tags, @status, @schedule, @helpful_count, @harmful_count)
    `),
    upsertEdge: db.prepare(`
      INSERT OR REPLACE INTO edges (source, target, type, subtype, context, weight, created_at, valid_from, valid_until)
      VALUES (@source, @target, @type, @subtype, @context, @weight, @created_at, @valid_from, @valid_until)
    `),
    deleteNode: db.prepare('DELETE FROM nodes WHERE id = ?'),
    deleteEdge: db.prepare('DELETE FROM edges WHERE source = ? AND target = ? AND type = ?'),
    deleteNodeEdges: db.prepare('DELETE FROM edges WHERE source = ? OR target = ?'),
    touchNode: db.prepare('UPDATE nodes SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?'),
    invalidateEdge: db.prepare('UPDATE edges SET valid_until = ? WHERE source = ? AND target = ? AND type = ?'),
    updateWeight: db.prepare('UPDATE nodes SET weight = ?, updated_at = ? WHERE id = ?'),
    pruneNode: db.prepare('INSERT OR REPLACE INTO pruned_nodes (id, data, pruned_at) VALUES (?, ?, ?)'),
    incrementHelpful: db.prepare('UPDATE nodes SET helpful_count = helpful_count + 1 WHERE id = ?'),
    incrementHarmful: db.prepare('UPDATE nodes SET harmful_count = harmful_count + 1 WHERE id = ?'),
  };
  stmtCache.set(db, stmts);
  return stmts;
}

/**
 * Save a node to both graph and SQLite.
 */
export function saveNode(graph, db, nodeProps) {
  const node = createNode(nodeProps);
  const stmts = getStmts(db);

  // Upsert in graph
  if (graph.hasNode(node.id)) {
    graph.replaceNodeAttributes(node.id, node);
  } else {
    graph.addNode(node.id, node);
  }

  // Write-through to SQLite with retry
  retryOnBusy(() => stmts.upsertNode.run({
    ...node,
    pinned: node.pinned ? 1 : 0,
    tags: JSON.stringify(node.tags),
    status: node.status || null,
    schedule: node.schedule || null,
    helpful_count: node.helpful_count || 0,
    harmful_count: node.harmful_count || 0
  }));

  return node;
}

/**
 * Save an edge to both graph and SQLite.
 */
export function saveEdge(graph, db, edgeProps) {
  const edge = createEdge(edgeProps);
  const stmts = getStmts(db);
  const key = `${edge.source}→${edge.target}:${edge.type}`;

  // Upsert in graph
  if (graph.hasEdge(key)) {
    graph.replaceEdgeAttributes(key, edge);
  } else {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
      throw new Error(`Cannot add edge: missing node(s) — source=${edge.source}, target=${edge.target}`);
    }
    graph.addEdgeWithKey(key, edge.source, edge.target, edge);
  }

  // Write-through to SQLite with retry
  retryOnBusy(() => stmts.upsertEdge.run(edge));

  return edge;
}

/**
 * Touch a node (update access time and count).
 */
export function touchNode(graph, db, nodeId) {
  if (!graph.hasNode(nodeId)) return;
  const now = Date.now();
  const stmts = getStmts(db);

  graph.updateNodeAttribute(nodeId, 'last_accessed', () => now);
  graph.updateNodeAttribute(nodeId, 'access_count', c => (c || 0) + 1);

  retryOnBusy(() => stmts.touchNode.run(now, nodeId));
}

/**
 * Remove a node (move to pruned_nodes).
 */
export function removeNode(graph, db, nodeId) {
  if (!graph.hasNode(nodeId)) return;
  const stmts = getStmts(db);
  const data = JSON.stringify(graph.getNodeAttributes(nodeId));

  // Archive + remove with retry (all writes in one retry block)
  retryOnBusy(() => {
    stmts.pruneNode.run(nodeId, data, Date.now());
    stmts.deleteNodeEdges.run(nodeId, nodeId);
    stmts.deleteNode.run(nodeId);
  });
  graph.dropNode(nodeId);
}

/**
 * Invalidate an edge — mark it as no longer true as of now.
 * Doesn't delete the edge; preserves history for temporal queries.
 */
export function invalidateEdge(graph, db, source, target, type) {
  const key = `${source}→${target}:${type}`;
  const now = Date.now();
  const stmts = getStmts(db);

  if (graph.hasEdge(key)) {
    graph.setEdgeAttribute(key, 'valid_until', now);
  }
  retryOnBusy(() => stmts.invalidateEdge.run(now, source, target, type));
}

/**
 * Get node count and edge count.
 */
export function stats(graph) {
  return {
    nodes: graph.order,
    edges: graph.size
  };
}

/**
 * Increment helpful_count for a node.
 */
export function markHelpful(graph, db, nodeId) {
  if (!graph.hasNode(nodeId)) return;
  const stmts = getStmts(db);
  graph.updateNodeAttribute(nodeId, 'helpful_count', c => (c || 0) + 1);
  retryOnBusy(() => stmts.incrementHelpful.run(nodeId));
}

/**
 * Increment harmful_count for a node.
 */
export function markHarmful(graph, db, nodeId) {
  if (!graph.hasNode(nodeId)) return;
  const stmts = getStmts(db);
  graph.updateNodeAttribute(nodeId, 'harmful_count', c => (c || 0) + 1);
  retryOnBusy(() => stmts.incrementHarmful.run(nodeId));
}

/**
 * Close the database connection.
 */
export function closeDB(db) {
  if (db) db.close();
}
