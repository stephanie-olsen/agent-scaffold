#!/usr/bin/env node
// graph-add.mjs — Add a node to the graph memory with auto-embedding.
//
// Usage:
//   node scripts/graph-add.mjs event "Discussed memory architecture with Steph"
//   node scripts/graph-add.mjs concept "Performativity" "Identity constituted through acts"
//   node scripts/graph-add.mjs lesson "Knowledge that doesn't change practice isn't integrated"
//   node scripts/graph-add.mjs entity "Sartre" "Existentialist philosopher"
//   node scripts/graph-add.mjs --edge source target type "optional context"
//   node scripts/graph-add.mjs --pin event "Critical system decision"
//
// Types: event, concept, entity, task, decision, preference, behavioral-principle, topical-principle, problem, impression
// Events get auto-timestamped IDs. Others use slugified names.

import { resolve } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { MemoryGraph } from '../../lib/graph-memory/index.mjs';

const DB_PATH = resolve(process.cwd(), 'data', 'memory-graph.sqlite');
const FILES_DIR = resolve(process.cwd(), 'data', 'graph-pipeline', 'consolidation-files');

// --- Parse args ---
const args = process.argv.slice(2);
let isEdge = false;
let pinned = false;
let reviewed = false;
let forceCommit = false;
let detail = null;
let detailFile = null;
let supersedesTarget = null;
const resolvedFromTargets = []; // --resolved-from id1 id2 ...

// Strip flags
const cleanArgs = [];
const edgeSpecs = []; // --edges "target:type:context" "target2:type2:context2"
let parsingEdges = false;
let parsingResolvedFrom = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--edge') { isEdge = true; parsingEdges = false; parsingResolvedFrom = false; continue; }
  if (arg === '--edges') { parsingEdges = true; parsingResolvedFrom = false; continue; }
  if (arg === '--pin') { pinned = true; parsingEdges = false; parsingResolvedFrom = false; continue; }
  if (arg === '--reviewed') { reviewed = true; parsingEdges = false; parsingResolvedFrom = false; continue; }
  if (arg === '--force') { forceCommit = true; parsingEdges = false; parsingResolvedFrom = false; continue; }
  if (arg === '--detail' && args[i + 1]) { detail = args[++i]; parsingEdges = false; parsingResolvedFrom = false; continue; }
  if (arg === '--detail-file' && args[i + 1]) { detailFile = args[++i]; parsingEdges = false; parsingResolvedFrom = false; continue; }
  if (arg === '--supersedes' && args[i + 1]) { supersedesTarget = args[++i]; parsingEdges = false; parsingResolvedFrom = false; continue; }
  if (arg === '--resolved-from') { parsingResolvedFrom = true; parsingEdges = false; continue; }
  if (parsingResolvedFrom && !arg.startsWith('--')) { resolvedFromTargets.push(arg); continue; }
  if (parsingResolvedFrom && arg.startsWith('--')) { parsingResolvedFrom = false; }
  if (parsingEdges && arg.includes(':')) { edgeSpecs.push(arg); continue; }
  if (parsingEdges) { parsingEdges = false; } // Non-edge arg ends edge parsing
  cleanArgs.push(arg);
}

// --- Embedding (model-agnostic, config in data/embed-config.json) ---
import { embedText } from '../../lib/graph-memory/embed-provider.mjs';
async function embed(text) { return embedText(text); }

// Kept for cleanup at end of script (no-op now)
const _embedder = null;

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function generateEventId() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  // Count existing events for today to get sequence number
  const seq = String(Date.now()).slice(-4);
  return `event-${date}-${seq}`;
}

// --- Main ---
async function main() {
  // Warn if staging has unreviewed entries
  const stagingPath = resolve(process.cwd(), 'data', 'graph-pipeline', 'graph-staging.json');
  try {
    const staged = JSON.parse(readFileSync(stagingPath, 'utf8'));
    if (staged.length > 0) {
      console.error(`Note: ${staged.length} entries awaiting review in staging. Run: node scripts/graph/graph-review.mjs`);
    }
  } catch {}

  const mem = new MemoryGraph(DB_PATH);

  try {
    if (isEdge) {
      // --edge source target type "context"
      const [source, target, type, context] = cleanArgs;
      if (!source || !target || !type) {
        console.error('Usage: graph-add.mjs --edge <source> <target> <type> ["context"]');
        process.exit(1);
      }
      const EDGE_TYPES = ['relates_to','part_of','exemplifies','inspired_by','involves','extends','derived_from','tension_with','contradicts','requires','enables','critiques','led_to','precedes','supersedes','supports','resolved_from'];
      if (!EDGE_TYPES.includes(type)) {
        console.error(`Error: "${type}" is not a valid edge type. Valid types: ${EDGE_TYPES.join(', ')}`);
        process.exit(1);
      }
      mem.addEdge({ source, target, type, context: context || '' });
      console.log(JSON.stringify({ action: 'edge', source, target, type, context }));
    } else {
      // node: type name [content]
      const [type, name, content] = cleanArgs;
      const NODE_TYPES = ['event','concept','entity','task','decision','preference','behavioral-principle','topical-principle','problem','impression'];
      if (!type || !name) {
        console.error('Usage: graph-add.mjs <type> <name> ["content"]');
        console.error(`Types: ${NODE_TYPES.join(', ')}`);
        process.exit(1);
      }
      if (!NODE_TYPES.includes(type)) {
        console.error(`Error: "${type}" is not a valid node type. Valid types: ${NODE_TYPES.join(', ')}`);
        process.exit(1);
      }

      const id = type === 'event' ? generateEventId() : slugify(name);
      // Derive readable name: "my-concept-name" → "my concept name"
      const readableName = type === 'event' ? name : name.replace(/-/g, ' ');
      const nodeContent = content || readableName;
      const nodeText = `${readableName}. ${nodeContent}`;

      // === DEDUP CHECK (3 levels) ===
      // Level 1: Exact ID match (non-events)
      const existing = type !== 'event' && mem.hasNode(id);
      const edgesOnly = existing && !forceCommit && (edgeSpecs.length > 0 || supersedesTarget || resolvedFromTargets.length > 0);
      if (existing && !forceCommit && !edgesOnly) {
        console.log(JSON.stringify({ action: 'exists', id, name }));
        return;
      }
      if (existing && forceCommit) {
        mem.remove(id);
      }

      // Level 2: Fuzzy name match (catches slug variations like "X vs Y" / "X-vs-Y")
      if (!existing && !edgesOnly) {
        const normName = readableName.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        const fuzzyMatch = mem.allNodes().find(n => {
          const norm = n.name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
          return norm === normName && n.id !== id;
        });
        if (fuzzyMatch && !forceCommit) {
          console.log(JSON.stringify({ action: 'fuzzy_duplicate', id, matchedId: fuzzyMatch.id, matchedName: fuzzyMatch.name }));
          return;
        }
      }

      // Level 3: Semantic similarity (catches conceptually overlapping nodes)
      let cachedVector = null;
      if (!existing && !edgesOnly && !forceCommit) {
        const SEMANTIC_SKIP_THRESHOLD = 0.97;
        const SEMANTIC_WARN_THRESHOLD = 0.92;
        try {
          cachedVector = await embed(nodeText);
          if (cachedVector && cachedVector.length > 0) {
            const candidateVector = cachedVector;
            const similar = mem.semanticSearch(candidateVector, { limit: 3, minScore: SEMANTIC_WARN_THRESHOLD });
            if (similar.length > 0) {
              const top = similar[0];
              if (top.score >= SEMANTIC_SKIP_THRESHOLD) {
                console.log(JSON.stringify({ action: 'semantic_duplicate', id, matchedId: top.id, matchedName: top.name, similarity: top.score.toFixed(4) }));
                return;
              }
              // Warn but still create
              console.error(`⚠️  DEDUP WARNING: "${readableName}" is similar to "${top.name}" (${top.id}, similarity=${top.score.toFixed(3)})`);
              if (similar.length > 1) {
                similar.slice(1).forEach(s => console.error(`   Also similar: "${s.name}" (${s.id}, ${s.score.toFixed(3)})`));
              }
            }
          }
        } catch (err) {
          console.error(`Dedup semantic check failed (proceeding): ${err.message}`);
        }
      }

      // Add node (skip if just adding edges to existing)
      let embedded = false;
      let filePath = null;
      if (!edgesOnly) {
        mem.addNode({ id, type, name: readableName, content: nodeContent, pinned });

        // Auto-embed (reuse cached vector from dedup check if available)
        try {
          const vector = cachedVector || await embed(nodeText);
          if (vector && vector.length > 0) {
            mem.storeEmbedding(id, vector);
            embedded = true;
          }
        } catch (err) {
          console.error(`Embedding failed for ${id}: ${err.message}`);
        }

        // Write flat file if --detail or --detail-file provided
        const detailContent = detailFile
          ? readFileSync(resolve(process.cwd(), detailFile), 'utf8')
          : detail;

        if (detailContent) {
          mkdirSync(FILES_DIR, { recursive: true });
          filePath = resolve(FILES_DIR, `${id}.md`);
          const fileBody = [
            `# ${name}`,
            '',
            detailContent,
            '',
            '---',
            `Node: ${id} | Type: ${type} | Created: ${new Date().toISOString()}`
          ].join('\n');
          writeFileSync(filePath, fileBody, 'utf8');
        }
      }

      // Add edges if --edges provided
      const addedEdges = [];
      if (edgeSpecs.length > 0) {
        const EDGE_TYPES = ['relates_to','part_of','exemplifies','inspired_by','involves','extends','derived_from','tension_with','contradicts','requires','enables','critiques','led_to','precedes','supersedes','supports','resolved_from'];
        for (const spec of edgeSpecs) {
          const parts = spec.split(':');
          if (parts.length < 2) { console.error(`Skipping malformed edge spec: ${spec} (need target:type[:context])`); continue; }
          const [target, edgeType, ...ctxParts] = parts;
          const edgeContext = ctxParts.join(':') || '';
          if (!EDGE_TYPES.includes(edgeType)) { console.error(`Skipping invalid edge type "${edgeType}" in spec: ${spec}`); continue; }
          if (!mem.hasNode(target)) {
            console.error(`Skipping edge to unknown node: ${target}`);
            // Track dropped edges for monitoring
            try {
              const { appendFileSync } = await import('fs');
              appendFileSync('data/graph-pipeline/dropped-edges.log', `${new Date().toISOString()} | ${id} -> ${target} (${edgeType}) | node not found\n`);
            } catch {}
            continue;
          }
          mem.addEdge({ source: id, target, type: edgeType, context: edgeContext });
          addedEdges.push({ target, type: edgeType });
        }
      }

      // Diversity check: warn if all edge targets are high-degree hub nodes
      if (addedEdges.length > 0) {
        const HUB_THRESHOLD = 10;
        // Use edges() method to count degree
        const getDegree = (nodeId) => { try { return mem.edges(nodeId).length; } catch { return 0; } };
        {
          const targetDegrees = addedEdges.map(e => ({
            target: e.target, degree: getDegree(e.target)
          }));
          const allHubs = targetDegrees.every(t => t.degree > HUB_THRESHOLD);
          if (allHubs && addedEdges.length >= 2) {
            // Find semantically similar low-degree nodes as concrete suggestions
            const storedEmb = mem.getEmbedding ? mem.getEmbedding(id) : null;
            const targetIds = new Set(addedEdges.map(e => e.target));
            targetIds.add(id);
            let suggestions = [];
            if (storedEmb) {
              const similar = mem.semanticSearch(storedEmb, { limit: 20, minScore: 0.4 });
              suggestions = similar
                .filter(s => !targetIds.has(s.id))
                .map(s => ({ ...s, degree: getDegree(s.id) }))
                .filter(s => s.degree <= HUB_THRESHOLD && s.degree > 0)
                .slice(0, 3);
            }
            if (suggestions.length > 0) {
              console.error(`💡 DIVERSITY HINT: All ${addedEdges.length} connections go to hub nodes. Similar low-degree nodes you might also connect to:`);
              suggestions.forEach(s => console.error(`   ${s.id} (${s.type}, degree ${s.degree}, similarity ${s.score.toFixed(2)})`));
            }
            // If no good suggestions, stay silent — the hub connections are probably correct
          }
        }
      }

      // Handle --supersedes: add supersedes edge from new node to old node
      // Also generate a remainder node if the old node had content not captured by the new one
      if (supersedesTarget) {
        if (mem.hasNode(supersedesTarget)) {
          const oldNode = mem.getNode(supersedesTarget);
          mem.addEdge({ source: id, target: supersedesTarget, type: 'supersedes', context: 'updated understanding' });
          addedEdges.push({ target: supersedesTarget, type: 'supersedes' });

          // Generate remainder: what did the old node say that the new one doesn't?
          if (oldNode && oldNode.content && content) {
            const oldWords = new Set(oldNode.content.toLowerCase().split(/\s+/).filter(w => w.length > 4));
            const newWords = new Set(content.toLowerCase().split(/\s+/).filter(w => w.length > 4));
            const remainderWords = [...oldWords].filter(w => !newWords.has(w));
            // If >30% of old content's key words are absent from new, create remainder
            if (remainderWords.length > oldWords.size * 0.3 && oldWords.size > 5) {
              const remainderId = `remainder-${supersedesTarget}`.slice(0, 80);
              if (!mem.hasNode(remainderId)) {
                const remainderContent = `Remainder from superseded node "${oldNode.name}": ${oldNode.content}`;
                mem.addNode({ id: remainderId, type: 'concept', name: `remainder: ${oldNode.name}`, content: remainderContent });
                mem.addEdge({ source: remainderId, target: supersedesTarget, type: 'derived_from', context: 'remainder from supersession' });
                mem.addEdge({ source: remainderId, target: id, type: 'tension_with', context: 'content lost in supersession' });
                // Embed the remainder
                const remEmb = await embed(remainderContent);
                if (remEmb) mem.storeEmbedding(remainderId, remEmb);
                console.error(`Created remainder node: ${remainderId}`);
              }
            }
          }
        } else {
          console.error(`Warning: --supersedes target "${supersedesTarget}" not found in graph`);
        }
      }

      // Handle --resolved-from: add resolved_from edges to tension/problem nodes this resolves
      if (resolvedFromTargets.length > 0) {
        for (const target of resolvedFromTargets) {
          if (mem.hasNode(target)) {
            mem.addEdge({ source: id, target, type: 'resolved_from', context: 'resolves tension' });
            addedEdges.push({ target, type: 'resolved_from' });
          } else {
            console.error(`Warning: --resolved-from target "${target}" not found in graph`);
          }
        }
      }

      console.log(JSON.stringify({ action: edgesOnly ? 'edges_added' : 'added', id, type, name, embedded, file: filePath ? `data/graph-pipeline/consolidation-files/${id}.md` : null, edges: addedEdges.length > 0 ? addedEdges : undefined }));
    }
  } finally {
    if (_embedder) _embedder.dispose();
    mem.close();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
