// index.mjs — Main entry point for graph memory system
//
// Usage:
//   import { MemoryGraph } from './lib/graph-memory/index.mjs';
//   const mem = new MemoryGraph();  // or MemoryGraph.open('path/to/db.sqlite')
//   mem.addNode({ id: 'steph', type: 'entity', name: 'Stephanie', content: 'My human', pinned: true });
//   mem.addEdge({ source: 'steph', target: 'thresh', type: 'relates_to', context: 'Human-agent partnership' });
//   console.log(mem.bootContext());
//   mem.close();

import { resolve } from 'path';
import { loadGraph, saveNode, saveEdge, touchNode, removeNode, invalidateEdge, markHelpful, markHarmful, stats, closeDB } from './persistence.mjs';
import { generateBootContext } from './boot.mjs';
import { runDecay, boostWeight, suppressWeight } from './decay.mjs';
import { spreadingActivation, findNodes } from './activate.mjs';
import { degreeCentrality, detectCommunities, findOrphans, decayReport, generateReport } from './analyze.mjs';
import { storeEmbedding, getEmbedding, vectorSearch, cosineSimilarity, keywordSearch } from './embed.mjs';

const DEFAULT_DB_PATH = resolve(process.cwd(), 'data', 'memory-graph.sqlite');

export class MemoryGraph {
  #graph;
  #db;

  constructor(dbPath = DEFAULT_DB_PATH) {
    const { graph, db } = loadGraph(dbPath);
    this.#graph = graph;
    this.#db = db;
  }

  static open(dbPath) {
    return new MemoryGraph(dbPath);
  }

  // --- Core Operations ---

  addNode(props) {
    const NODE_CONTENT_MAX = 150;
    if (props.content && props.content.length > NODE_CONTENT_MAX) {
      throw new Error(`Node content too long (${props.content.length} chars, max ${NODE_CONTENT_MAX}) for id: ${props.id || props.name}. Shorten the content and retry.`);
    }
    if (props.name && props.name.length > NODE_CONTENT_MAX) {
      props.name = props.name.slice(0, NODE_CONTENT_MAX).replace(/\s+\S*$/, '') + '…';
    }
    return saveNode(this.#graph, this.#db, props);
  }

  addEdge(props) {
    return saveEdge(this.#graph, this.#db, props);
  }

  touch(nodeId) {
    touchNode(this.#graph, this.#db, nodeId);
  }

  remove(nodeId) {
    removeNode(this.#graph, this.#db, nodeId);
  }

  boost(nodeId, amount = 0.2) {
    boostWeight(this.#graph, this.#db, nodeId, amount);
  }

  suppress(nodeId, penalty = 0.02) {
    suppressWeight(this.#graph, this.#db, nodeId, penalty);
  }

  /** Mark a node as helpful (returned useful results). */
  markHelpful(nodeId) {
    markHelpful(this.#graph, this.#db, nodeId);
  }

  /** Mark a node as harmful (returned misleading results). */
  markHarmful(nodeId) {
    markHarmful(this.#graph, this.#db, nodeId);
  }

  /** Mark an edge as no longer valid (temporal invalidation). Preserves history. */
  invalidate(source, target, type) {
    invalidateEdge(this.#graph, this.#db, source, target, type);
  }

  // --- Query ---

  getNode(id) {
    if (!this.#graph.hasNode(id)) return null;
    return { id, ...this.#graph.getNodeAttributes(id) };
  }

  hasNode(id) {
    return this.#graph.hasNode(id);
  }

  find(query, opts = {}) {
    return findNodes(this.#graph, query, opts);
  }

  neighbors(nodeId) {
    if (!this.#graph.hasNode(nodeId)) return [];
    return this.#graph.mapNeighbors(nodeId, (id, attrs) => ({ id, ...attrs }));
  }

  edges(nodeId) {
    if (!this.#graph.hasNode(nodeId)) return [];
    return this.#graph.mapEdges(nodeId, (key, attrs, source, target) => ({
      key, source, target, ...attrs
    }));
  }

  // --- Activation ---

  activate(seeds, opts = {}) {
    return spreadingActivation(this.#graph, seeds, opts);
  }

  // --- Semantic Search ---

  /** Store an embedding for a node */
  storeEmbedding(nodeId, vector) {
    storeEmbedding(this.#db, nodeId, vector);
  }

  /** Get embedding for a node */
  getEmbedding(nodeId) {
    return getEmbedding(this.#db, nodeId);
  }

  /** Find nodes similar to a query vector */
  semanticSearch(queryVector, opts = {}) {
    return vectorSearch(this.#db, queryVector, opts);
  }

  /** FTS5 keyword search on node names and content */
  keywordSearch(query, opts = {}) {
    return keywordSearch(this.#db, query, opts);
  }

  /** Hybrid search: combine semantic similarity, graph activation, and keyword search */
  hybridSearch(queryVector, seeds = [], opts = {}) {
    const { vectorWeight = 0.5, graphWeight = 0.5, keywordWeight = 0, keywordQuery = '', limit = 15, minScore = 0.2, since = null, until = null } = opts;
    
    // Get vector results (pre-filtered by time range if specified)
    const vecResults = vectorSearch(this.#db, queryVector, { limit: limit * 2, minScore: 0.2, since, until });
    
    // Get graph activation results (if seeds provided)
    // Seeds may be objects { id, score } or strings — normalize to string IDs for activation
    const seedIds = seeds.map(s => typeof s === 'string' ? s : s.id);
    const graphResults = seedIds.length > 0 
      ? spreadingActivation(this.#graph, seedIds, { maxResults: limit * 2 })
      : [];

    // Get keyword results
    const kwResults = (keywordWeight > 0 && keywordQuery)
      ? keywordSearch(this.#db, keywordQuery, { limit: limit * 2 })
      : [];

    // --- Min-max normalize each signal to [0, 1] ---
    // This ensures weights actually control relative importance regardless of raw score ranges
    function minMaxNormalize(results, scoreKey = 'score') {
      if (results.length === 0) return results;
      const scores = results.map(r => r[scoreKey]);
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      const range = max - min;
      return results.map(r => ({
        ...r,
        normScore: range > 0 ? (r[scoreKey] - min) / range : 1.0  // single result gets 1.0
      }));
    }

    const normVec = minMaxNormalize(vecResults);
    const normGraph = minMaxNormalize(graphResults);
    const normKw = minMaxNormalize(kwResults);

    // Merge with normalized weighted scores
    const merged = new Map();
    
    for (const r of normVec) {
      merged.set(r.id, { 
        id: r.id, name: r.name, type: r.type,
        vecScore: r.normScore, graphScore: 0, kwScore: 0,
        score: r.normScore * vectorWeight 
      });
    }
    
    for (const r of normGraph) {
      const existing = merged.get(r.id);
      if (existing) {
        existing.graphScore = r.normScore;
        existing.score = existing.vecScore * vectorWeight + r.normScore * graphWeight;
      } else {
        merged.set(r.id, {
          id: r.id, name: r.attrs.name, type: r.attrs.type,
          vecScore: 0, graphScore: r.normScore, kwScore: 0,
          score: r.normScore * graphWeight
        });
      }
    }

    // Keyword merge
    for (const r of normKw) {
      const existing = merged.get(r.id);
      if (existing) {
        existing.kwScore = r.normScore;
        existing.score += r.normScore * keywordWeight;
      } else {
        merged.set(r.id, {
          id: r.id, name: r.name, type: r.type,
          vecScore: 0, graphScore: 0, kwScore: r.normScore,
          score: r.normScore * keywordWeight
        });
      }
    }
    
    // Enrich entries with degree and weight metadata (for external use / near-miss logging)
    // NOTE: Degree is NO LONGER used for ranking. Evaluation (2026-02-09) showed equal-weight
    // RRF with degree rank degraded Top-1 accuracy from 96% to 8% across 25 test queries.
    // Graph activation already encodes structural importance via edge spreading — degree
    // ranking on top double-counted it and systematically buried low-degree, high-relevance nodes.
    // See: data/graph-files/rrf-degree-bias-buries-relevant-nodes.md
    const ids = [...merged.keys()];
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const metaRows = this.#db.prepare(`
        SELECT n.id, n.weight,
          (SELECT COUNT(*) FROM edges e WHERE e.source = n.id OR e.target = n.id) as degree
        FROM nodes n WHERE n.id IN (${placeholders})
      `).all(...ids);
      const degreeMap = new Map(metaRows.map(r => [r.id, r.degree]));
      const weightMap = new Map(metaRows.map(r => [r.id, r.weight]));
      
      for (const entry of merged.values()) {
        entry.nodeWeight = weightMap.get(entry.id) ?? 1.0;
        entry.degree = degreeMap.get(entry.id) ?? 0;
        entry.baseScore = entry.score; // preserve for compatibility
      }
    }

    // Temporal filtering (since/until are epoch-ms or Date)
    let results = [...merged.values()];
    if (since || until) {
      const sinceMs = since ? (since instanceof Date ? since.getTime() : Number(since)) : 0;
      const untilMs = until ? (until instanceof Date ? until.getTime() : Number(until)) : Infinity;
      const ids = results.map(r => r.id);
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        const rows = this.#db.prepare(`SELECT id, created_at FROM nodes WHERE id IN (${placeholders})`).all(...ids);
        const timeMap = new Map(rows.map(r => [r.id, r.created_at]));
        results = results.filter(r => {
          const t = timeMap.get(r.id);
          if (t == null) return false;
          return t >= sinceMs && t <= untilMs;
        });
      }
    }

    const sorted = results.sort((a, b) => b.score - a.score);
    const returned = sorted.slice(0, limit);
    const nearMisses = sorted.slice(limit, limit + Math.ceil(limit * 0.5));

    // Retrieval mutation: boost hits, competition-aware suppression of near-misses
    // Kuhl 2007: only memories that compete with the target get suppressed,
    // and suppression magnitude correlates with initial conflict strength.
    if (opts.mutate !== false) {
      for (const r of returned) {
        boostWeight(this.#graph, this.#db, r.id, 0.05);
      }
      // Get top result's embedding for competition measurement
      const topEmb = returned.length > 0 ? getEmbedding(this.#db, returned[0].id) : null;
      for (const r of nearMisses) {
        if (!topEmb) {
          suppressWeight(this.#graph, this.#db, r.id, 0.02);
          continue;
        }
        const nmEmb = getEmbedding(this.#db, r.id);
        if (!nmEmb) {
          suppressWeight(this.#graph, this.#db, r.id, 0.02);
          continue;
        }
        // Higher similarity to top hit = more competition = stronger suppression
        // Similarity range [0,1] → penalty range [0, 0.05]
        // Below 0.3 similarity: no suppression (not competing)
        const sim = cosineSimilarity(topEmb, nmEmb);
        if (sim < 0.3) continue; // not competing, skip suppression
        const penalty = 0.05 * ((sim - 0.3) / 0.7); // linear scale: 0 at 0.3, 0.05 at 1.0
        if (penalty > 0.001) {
          suppressWeight(this.#graph, this.#db, r.id, penalty);
        }
      }
    }

    return returned;
  }

  // --- Boot Context ---

  bootContext(opts = {}) {
    return generateBootContext(this.#graph, opts);
  }

  // --- Decay ---

  decay(opts = {}) {
    return runDecay(this.#graph, this.#db, opts);
  }

  // --- Analysis ---

  centrality() {
    return degreeCentrality(this.#graph);
  }

  communities() {
    return detectCommunities(this.#graph);
  }

  orphans() {
    return findOrphans(this.#graph);
  }

  decayReport() {
    return decayReport(this.#graph);
  }

  report() {
    return generateReport(this.#graph);
  }

  // --- Stats ---

  stats() {
    return stats(this.#graph);
  }

  // Return all nodes (for inspection/export)
  allNodes() {
    const nodes = [];
    this.#graph.forEachNode((id, attrs) => nodes.push({ id, ...attrs }));
    return nodes;
  }

  // Return all edges
  allEdges() {
    const edges = [];
    this.#graph.forEachEdge((key, attrs, source, target) => {
      edges.push({ key, source, target, ...attrs });
    });
    return edges;
  }

  // --- Lifecycle ---

  close() {
    closeDB(this.#db);
  }
}

export default MemoryGraph;
