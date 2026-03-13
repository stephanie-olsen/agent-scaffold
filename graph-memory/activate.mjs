// activate.mjs — Spreading activation for contextual retrieval

/**
 * Spreading activation: start from seed nodes, walk edges outward,
 * return connected nodes weighted by distance and node/edge weight.
 *
 * This captures associative context that embedding-based search misses.
 *
 * @param {Graph} graph
 * @param {string|string[]} seeds - Starting node id(s)
 * @param {object} opts
 * @param {number} opts.maxHops - Max edge traversal depth (default 2)
 * @param {number} opts.hopDecay - Weight multiplier per hop (default 0.5)
 * @param {number} opts.maxResults - Max nodes to return (default 20)
 * @param {number} opts.minScore - Minimum activation score (default 0.01)
 * @returns {Array<{ id: string, score: number, path: string[], attrs: object }>}
 */
export function spreadingActivation(graph, seeds, opts = {}) {
  const {
    maxHops = 2,
    hopDecay = 0.5,
    maxResults = 20,
    minScore = 0.01
  } = opts;

  const seedSet = new Set(Array.isArray(seeds) ? seeds : [seeds]);
  const scores = new Map(); // nodeId → { score, path }
  const visited = new Set();
  let frontier = [];

  // Initialize frontier with seeds
  for (const seed of seedSet) {
    if (!graph.hasNode(seed)) continue;
    const seedWeight = graph.getNodeAttribute(seed, 'weight') || 1.0;
    scores.set(seed, { score: seedWeight, path: [seed] });
    frontier.push({ id: seed, score: seedWeight, hop: 0, path: [seed] });
  }

  // BFS with decay
  while (frontier.length > 0) {
    const nextFrontier = [];

    for (const { id, score, hop, path } of frontier) {
      if (hop >= maxHops) continue;
      if (visited.has(id)) continue;
      visited.add(id);

      // Walk all neighbors — dampen activation through high-degree hubs
      const degree = graph.degree(id);
      const hubDampen = degree > 1 ? Math.log(degree + 1) : 1;

      graph.forEachNeighbor(id, (neighborId, neighborAttrs) => {
        if (seedSet.has(neighborId)) return; // don't revisit seeds

        // Get edge weight (check both directions)
        let edgeWeight = 1.0;
        graph.forEachEdge(id, neighborId, (edgeKey, edgeAttrs) => {
          edgeWeight = Math.max(edgeWeight, edgeAttrs.weight || 1.0);
        });

        const neighborWeight = neighborAttrs.weight || 0.5;
        const activationScore = (score / hubDampen) * hopDecay * edgeWeight * neighborWeight;

        if (activationScore < minScore) return;

        const newPath = [...path, neighborId];
        const existing = scores.get(neighborId);
        if (!existing || activationScore > existing.score) {
          scores.set(neighborId, { score: activationScore, path: newPath });
        }

        nextFrontier.push({
          id: neighborId,
          score: activationScore,
          hop: hop + 1,
          path: newPath
        });
      });
    }

    frontier = nextFrontier;
  }

  // Remove seeds from results (we already know about them)
  for (const seed of seedSet) {
    scores.delete(seed);
  }

  // Sort by score, return top results
  return [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, maxResults)
    .map(([id, { score, path }]) => ({
      id,
      score,
      path,
      attrs: graph.getNodeAttributes(id)
    }));
}

/**
 * Find nodes by name/content substring match.
 * Useful for finding seed nodes before activation.
 *
 * @param {Graph} graph
 * @param {string} query
 * @param {object} opts
 * @param {number} opts.limit - Max results (default 10)
 * @param {string} opts.type - Filter by node type
 * @returns {Array<{ id: string, attrs: object }>}
 */
export function findNodes(graph, query, opts = {}) {
  const { limit = 10, type } = opts;
  const q = query.toLowerCase();
  const results = [];

  graph.forEachNode((id, attrs) => {
    if (type && attrs.type !== type) return;
    const searchable = `${id} ${attrs.name} ${attrs.content} ${(attrs.tags || []).join(' ')}`.toLowerCase();
    if (searchable.includes(q)) {
      results.push({ id, attrs });
    }
  });

  // Sort by weight (most relevant first)
  results.sort((a, b) => (b.attrs.weight || 0) - (a.attrs.weight || 0));
  return results.slice(0, limit);
}
