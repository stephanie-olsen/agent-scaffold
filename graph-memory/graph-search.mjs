#!/usr/bin/env node
// graph-search.mjs — Query the graph memory directly.
//
// Usage:
//   node scripts/graph-search.mjs "what connects Sartre to Butler"
//   node scripts/graph-search.mjs --limit 10 --min-score 0.25 "agency and performativity"
//   node scripts/graph-search.mjs --since 24h "what happened today"
//   node scripts/graph-search.mjs --since 2026-02-07 --until 2026-02-08 "identity"
//
// Temporal filters: --since and --until accept:
//   Relative: "24h", "7d", "2w" (hours, days, weeks)
//   Absolute: ISO date or datetime ("2026-02-07", "2026-02-07T12:00:00")
//
// Returns JSON array of results with id, name, type, score, content, neighbors.

import { resolve } from 'path';
import { existsSync, appendFileSync, mkdirSync } from 'fs';
import { MemoryGraph } from '../../lib/graph-memory/index.mjs';
import { SEARCH_WEIGHTS } from '../embedding/search-config.mjs';

// Computed after arg parsing; placeholder
let SEARCH_LOG_DIR;

// --use-main-graph: always resolve against main workspace, not cwd
// Useful for sub-agents (e.g. skeptic) whose cwd is agents/<name>/
const MAIN_WORKSPACE = resolve(import.meta.dirname, '..', '..');
const USE_MAIN_GRAPH_DEFAULT = false;
let useMainGraph = USE_MAIN_GRAPH_DEFAULT;

// --- Parse args ---
const args = process.argv.slice(2);
let limit = 10;
let minScore = 0.2;
let query = '';
let verbose = false;
let since = null;
let until = null;
let mutate = true;
let chain = false;
let agent = process.env.OPENCLAW_AGENT || 'unknown';

function parseTimeArg(val) {
  // Relative: "24h", "7d", "2w"
  const relMatch = val.match(/^(\d+)(h|d|w)$/);
  if (relMatch) {
    const n = parseInt(relMatch[1]);
    const unit = relMatch[2];
    const ms = unit === 'h' ? n * 3600000 : unit === 'd' ? n * 86400000 : n * 604800000;
    return Date.now() - ms;
  }
  // Absolute: ISO date or datetime
  const d = new Date(val);
  if (!isNaN(d.getTime())) return d.getTime();
  throw new Error(`Cannot parse time: ${val}`);
}

let multi = false;
let typeFilter = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && args[i + 1]) { limit = parseInt(args[i + 1]); i++; }
  else if (args[i] === '--min-score' && args[i + 1]) { minScore = parseFloat(args[i + 1]); i++; }
  else if (args[i] === '--since' && args[i + 1]) { since = parseTimeArg(args[i + 1]); i++; }
  else if (args[i] === '--until' && args[i + 1]) { until = parseTimeArg(args[i + 1]); i++; }
  else if (args[i] === '--verbose' || args[i] === '-v') { verbose = true; }
  else if (args[i] === '--no-mutate') { mutate = false; }
  else if (args[i] === '--chain') { chain = true; }
  else if (args[i] === '--multi') { multi = true; }
  else if (args[i] === '--agent' && args[i + 1]) { agent = args[i + 1]; i++; }
  else if (args[i] === '--use-main-graph') { useMainGraph = true; }
  else if (args[i] === '--type' && args[i + 1]) { typeFilter = args[i + 1]; i++; }
  else { query += (query ? ' ' : '') + args[i]; }
}

const DB_BASE = useMainGraph ? MAIN_WORKSPACE : process.cwd();
const DB_PATH = resolve(DB_BASE, 'data', 'memory-graph.sqlite');
SEARCH_LOG_DIR = resolve(DB_BASE, 'data', 'search-logs');

if (!query) {
  console.error('Usage: node scripts/graph-search.mjs [--limit N] [--min-score F] [--use-main-graph] "query"');
  process.exit(1);
}

// --- Embedding (model-agnostic, config in data/embed-config.json) ---
import { embedText } from '../../lib/graph-memory/embed-provider.mjs';
async function embedQuery(text) { return embedText(text); }

// --- Multi-phrasing ---
// Generate alternative query phrasings without LLM calls.
// Strategy: original + keywords-only + noun-phrase reorder
function generatePhrasings(q) {
  const phrasings = [q];

  // Extract keywords: remove common stop words, keep content words
  const stopWords = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
    'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
    'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
    'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
    'same', 'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and',
    'or', 'if', 'while', 'about', 'what', 'which', 'who', 'whom', 'this',
    'that', 'these', 'those', 'am', 'it', 'its', 'my', 'your', 'his',
    'her', 'our', 'their', 'i', 'you', 'he', 'she', 'we', 'they', 'me',
    'him', 'us', 'them',
  ]);
  const words = q.toLowerCase().replace(/[^\w\s-]/g, '').split(/\s+/);
  const keywords = words.filter(w => !stopWords.has(w) && w.length > 1);

  if (keywords.length >= 2 && keywords.join(' ') !== q.toLowerCase().trim()) {
    phrasings.push(keywords.join(' '));
  }

  // Reverse keyword order — searches different embedding neighborhood
  if (keywords.length >= 3) {
    phrasings.push([...keywords].reverse().join(' '));
  }

  return [...new Set(phrasings)]; // dedupe
}

// --- Main ---
async function main() {
  const mem = new MemoryGraph(DB_PATH);

  try {
    // Determine queries to run
    const queries = multi ? generatePhrasings(query) : [query];
    if (multi && verbose) {
      console.error(`[multi] Phrasings: ${JSON.stringify(queries)}`);
    }

    // Embed all queries (parallel)
    const queryVecs = await Promise.all(queries.map(q => embedQuery(q)));
    const queryVec = queryVecs[0]; // primary for non-multi codepath

    // Run hybrid search for each phrasing, merge by max score
    const nearMissLimit = Math.max(limit + 10, 20);
    const mergedMap = new Map(); // id -> best result

    for (let qi = 0; qi < queries.length; qi++) {
      const qVec = queryVecs[qi];
      const qText = queries[qi];

      const vecResults = mem.semanticSearch(qVec, { limit: 5, minScore: 0.3 });
      const seeds = vecResults.map(r => r.id);

      const results = mem.hybridSearch(qVec, seeds, {
        ...SEARCH_WEIGHTS,
        keywordQuery: qText,
        limit: nearMissLimit,
        minScore: Math.min(minScore, 0.15),
        since,
        until,
        mutate: false,
      });

      for (const r of results) {
        const existing = mergedMap.get(r.id);
        if (!existing || r.score > existing.score) {
          mergedMap.set(r.id, { ...r, _fromQuery: qi });
        }
      }
    }

    const allResults = [...mergedMap.values()];
    // Demote superseded nodes (nodes with incoming 'supersedes' edges)
    for (const r of allResults) {
      try {
        const edges = mem.edges(r.id);
        const isSuperseded = edges.some(e => e.type === 'supersedes' && e.target === r.id);
        if (isSuperseded) r.score *= 0.1;
      } catch { /* node might not exist in graph */ }
    }
    // Apply type filter if specified
    if (typeFilter) {
      const types = typeFilter.split(',');
      for (let i = allResults.length - 1; i >= 0; i--) {
        const node = mem.getNode(allResults[i].id);
        if (!node || !types.includes(node.type)) allResults.splice(i, 1);
      }
    }
    allResults.sort((a, b) => b.score - a.score);

    const results = allResults.slice(0, limit);
    const nearMissResults = allResults.slice(limit, limit + Math.ceil(limit * 0.5));

    // Retrieval mutation: boost hits, suppress near-misses (RIF)
    if (mutate) {
      for (const r of results) {
        mem.boost(r.id, 0.05);
      }
      for (const r of nearMissResults) {
        mem.suppress(r.id, 0.02);
      }
    }

    // Enrich results with content, neighbors, and flat file paths
    const FILES_DIR = resolve(process.cwd(), 'data', 'graph-pipeline', 'consolidation-files');
    const enriched = results.map(r => {
      const node = mem.getNode(r.id);
      const neighbors = mem.neighbors(r.id)
        .map(n => ({ id: n.id, type: n.type }))
        .slice(0, 5);

      // Check for flat file with extended content
      const filePath = resolve(FILES_DIR, `${r.id}.md`);
      const hasFile = existsSync(filePath);

      return {
        id: r.id,
        name: r.name || node?.name,
        type: r.type || node?.type,
        score: Math.round(r.score * 1000) / 1000,
        content: node?.content || '',
        weight: node?.weight != null ? Math.round(node.weight * 100) / 100 : undefined,
        file: hasFile ? `data/graph-pipeline/consolidation-files/${r.id}.md` : undefined,
        neighbors: neighbors.length > 0 ? neighbors : undefined,
        ...(node?.helpful_count || node?.harmful_count ? { helpful: node.helpful_count, harmful: node.harmful_count } : {}),
        ...(verbose ? { vecScore: r.vecScore, graphScore: r.graphScore, kwScore: r.kwScore } : {}),
      };
    });

    // Chain retrieval: surface neighbors of top results
    let chainResults = [];
    if (chain) {
      const hitIds = new Set(enriched.map(r => r.id));
      const neighborScores = new Map(); // id -> { node, maxEdgeScore, viaNode, edgeType, edgeContext }

      for (const r of enriched) {
        const edges = mem.edges(r.id);
        for (const e of edges) {
          const neighborId = e.source === r.id ? e.target : e.source;
          if (hitIds.has(neighborId)) continue;
          const node = mem.getNode(neighborId);
          if (!node || node.type === 'event' || node.type === 'task') continue;
          // Score: parent result score * edge specificity bonus
          const edgeBonus = (e.type && e.type !== 'relates_to') ? 1.2 : 1.0;
          const score = r.score * edgeBonus * (node.weight || 0.5);
          const existing = neighborScores.get(neighborId);
          if (!existing || score > existing.maxEdgeScore) {
            neighborScores.set(neighborId, {
              node, maxEdgeScore: score,
              viaNode: r.name, edgeType: e.type || 'relates_to',
              edgeContext: e.context || ''
            });
          }
        }
      }

      chainResults = [...neighborScores.entries()]
        .sort((a, b) => b[1].maxEdgeScore - a[1].maxEdgeScore)
        .slice(0, 10)
        .map(([id, info]) => {
          const filePath = resolve(FILES_DIR, `${id}.md`);
          const hasFile = existsSync(filePath);
          return {
            id,
            name: info.node.name,
            type: info.node.type,
            chainScore: Math.round(info.maxEdgeScore * 1000) / 1000,
            via: `${info.viaNode} (${info.edgeType}${info.edgeContext ? ': ' + info.edgeContext : ''})`,
            content: info.node.content || '',
            file: hasFile ? `data/graph-pipeline/consolidation-files/${id}.md` : undefined,
          };
        });
    }

    // Verbose near-miss output
    if (verbose && mutate && nearMissResults.length > 0) {
      console.error(`[RIF] Suppressed ${nearMissResults.length} near-misses: ${nearMissResults.map(r => r.name || r.id).join(', ')}`);
    }

    // Log search for near-miss analysis
    try {
      mkdirSync(SEARCH_LOG_DIR, { recursive: true });
      const nearMisses = allResults.slice(limit).map(r => ({
        id: r.id,
        name: r.name,
        score: Math.round(r.score * 1000) / 1000
      }));
      const logEntry = {
        timestamp: new Date().toISOString(),
        agent,
        query,
        limit,
        topK: enriched.map(r => ({ id: r.id, score: r.score })),
        nearMisses,
      };
      const dateStr = new Date().toISOString().slice(0, 10);
      appendFileSync(
        resolve(SEARCH_LOG_DIR, `${dateStr}.jsonl`),
        JSON.stringify(logEntry) + '\n'
      );
    } catch { /* logging is best-effort */ }

    // Null-result awareness: warn when best results are low-relevance (adequate-trap mitigation)
    const topScore = enriched.length > 0 ? enriched[0].score : 0;
    if (enriched.length === 0) {
      console.error('[NULL-RESULT] No results found. The graph has nothing on this topic.');
    } else if (topScore < 0.3) {
      console.error(`[LOW-RELEVANCE] Best score ${topScore} < 0.3. These results may be noise, not signal. Consider that the graph genuinely has nothing relevant here.`);
    }

    if (chain && chainResults.length > 0) {
      console.log(JSON.stringify({ results: enriched, chain: chainResults }, null, 2));
    } else {
      console.log(JSON.stringify(enriched, null, 2));
    }
  } finally {
    mem.close();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
