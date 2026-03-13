// embed.mjs — Embedding utilities for graph memory
import { retryOnBusy } from './retry.mjs';
// Embeddings are stored as Float32Array buffers in SQLite BLOB columns.
// The actual embedding generation is done externally (via scripts/embed-nodes.mjs).
// This module provides storage, retrieval, and similarity functions.

/**
 * Store an embedding vector for a node.
 * @param {Database} db - better-sqlite3 instance
 * @param {string} nodeId
 * @param {number[]} vector - embedding vector
 */
export function storeEmbedding(db, nodeId, vector) {
  const buf = Buffer.from(new Float32Array(vector).buffer);
  retryOnBusy(() => db.prepare('UPDATE nodes SET embedding = ? WHERE id = ?').run(buf, nodeId));
}

/**
 * Get the embedding for a node.
 * @param {Database} db
 * @param {string} nodeId
 * @returns {Float32Array|null}
 */
export function getEmbedding(db, nodeId) {
  const row = db.prepare('SELECT embedding FROM nodes WHERE id = ?').get(nodeId);
  if (!row?.embedding) return null;
  return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Find nodes most similar to a query vector.
 * @param {Database} db
 * @param {number[]} queryVector
 * @param {object} opts
 * @param {number} opts.limit - max results (default 10)
 * @param {number} opts.minScore - minimum cosine similarity (default 0.3)
 * @param {string} opts.type - filter by node type
 * @returns {Array<{id: string, score: number, name: string, type: string}>}
 */
export function vectorSearch(db, queryVector, opts = {}) {
  const { limit = 10, minScore = 0.3, type, since = null, until = null } = opts;
  
  // Build query with optional temporal and type filters
  const conditions = ['embedding IS NOT NULL'];
  const params = [];
  if (type) { conditions.push('type = ?'); params.push(type); }
  if (since) { conditions.push('created_at >= ?'); params.push(since instanceof Date ? since.getTime() : Number(since)); }
  if (until) { conditions.push('created_at <= ?'); params.push(until instanceof Date ? until.getTime() : Number(until)); }
  
  const query = db.prepare(`SELECT id, name, type, embedding FROM nodes WHERE ${conditions.join(' AND ')}`);
  const rows = query.all(...params);
  const qVec = new Float32Array(queryVector);
  
  const results = [];
  for (const row of rows) {
    if (!row.embedding) continue;
    const nodeVec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    const score = cosineSimilarity(qVec, nodeVec);
    if (score >= minScore) {
      results.push({ id: row.id, score, name: row.name, type: row.type });
    }
  }
  
  // Also search alias embeddings (node_aliases table) if it exists
  try {
    const aliasRows = db.prepare(
      `SELECT node_id, alias_text, embedding FROM node_aliases WHERE embedding IS NOT NULL`
    ).all();
    for (const row of aliasRows) {
      if (!row.embedding) continue;
      const aliasVec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const score = cosineSimilarity(qVec, aliasVec);
      if (score >= minScore) {
        // Check if this node already has a better score from direct embedding
        const existing = results.find(r => r.id === row.node_id);
        if (existing) {
          if (score > existing.score) existing.score = score;
        } else {
          // Need node metadata — look it up
          const node = db.prepare('SELECT id, name, type FROM nodes WHERE id = ?').get(row.node_id);
          if (node) {
            results.push({ id: node.id, score, name: node.name, type: node.type });
          }
        }
      }
    }
  } catch { /* node_aliases table may not exist */ }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * FTS5 keyword search on node names and content.
 * @param {Database} db
 * @param {string} query - search query (supports FTS5 syntax)
 * @param {object} opts
 * @param {number} opts.limit - max results (default 10)
 * @param {string} opts.type - filter by node type
 * @returns {Array<{id: string, score: number, name: string, type: string}>}
 */
export function keywordSearch(db, query, opts = {}) {
  const { limit = 10, type } = opts;

  // Escape special FTS5 characters and build query
  // Filter stop words so natural language queries work with AND logic
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'must',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they', 'them',
    'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
    'am', 'not', 'no', 'nor', 'so', 'if', 'or', 'and', 'but', 'for', 'of',
    'at', 'by', 'to', 'in', 'on', 'with', 'from', 'up', 'about', 'into',
    'through', 'during', 'before', 'after', 'above', 'below', 'between',
    'how', 'why', 'when', 'where', 'there', 'here', 'then', 'than',
    'very', 'just', 'also', 'more', 'much', 'some', 'any', 'all', 'each',
    'does', 'make', 'makes', 'made', 'get', 'got', 'go', 'went', 'come', 'came',
    'happen', 'happened', 'work', 'works', 'worked',
  ]);

  const tokens = query
    .replace(/['"*(){}[\]^~\\:]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));

  if (tokens.length === 0) return [];

  // Build FTS5 query: each token as prefix match, combined with OR
  // BM25 naturally ranks docs matching more terms higher; AND was too restrictive
  // for 3+ token queries (zero results when all terms required). Changed 2026-02-15.
  const ftsQuery = tokens.map(t => `"${t}"*`).join(' OR ');

  try {
    // bm25 weights: name=10x, content=1x (id and type are UNINDEXED, weight 0)
    const sql = type
      ? `SELECT id, name, type, bm25(nodes_fts, 0, 10.0, 1.0, 0) as rank FROM nodes_fts WHERE nodes_fts MATCH ? AND type = ? ORDER BY rank LIMIT ?`
      : `SELECT id, name, type, bm25(nodes_fts, 0, 10.0, 1.0, 0) as rank FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY rank LIMIT ?`;

    const rows = type
      ? db.prepare(sql).all(ftsQuery, type, limit)
      : db.prepare(sql).all(ftsQuery, limit);

    // BM25 rank is negative (lower = better). Normalize to 0-1 range
    // comparable with vector scores (typically 0.5-0.9).
    // Use rank-relative normalization: best result gets ~0.9, worst gets ~0.3.
    if (rows.length === 0) return [];
    const bestRank = -rows[0].rank;  // most negative = best
    const worstRank = -rows[rows.length - 1].rank;
    const range = bestRank - worstRank;
    
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      // Map to 0.3-0.9 range; single result gets 0.9
      score: range > 0
        ? 0.3 + 0.6 * ((-r.rank - worstRank) / range)
        : 0.9,
    }));
  } catch {
    // FTS query syntax error — fall back to empty results
    return [];
  }
}
