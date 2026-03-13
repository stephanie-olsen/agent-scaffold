// boot.mjs — Generate boot context from graph queries
//
// Design principle: MEMORY.md should contain what can't wait for a search.
// Identity (IDENTITY.md), user info (USER.md), tools (TOOLS.md), and
// workflow (AGENTS.md) are loaded separately — don't duplicate them.
//
// Priority order (MEMORY.md loads last in boot context — end position):
//   1. Directives — behavioral rules (won't surface via topical search)
// Directives = end-of-context primacy (see: primacy-recency-position-affects-category)
//
// NOT included: high-weight well-connected nodes (they surface via search),
// identity info (in IDENTITY.md), user info (in USER.md).

/**
 * Generate a compact boot context string from the graph.
 */
export function generateBootContext(graph, opts = {}) {
  const {
    maxDirectives = 15,
  } = opts;

  const now = Date.now();
  const sections = [];
  const shown = new Set();

  // 1. Directives — behavioral rules that won't surface via topical search
  //    Placed last in MEMORY.md (last boot file) = absolute end of context = strongest recency position
  //    See: primacy-recency-position-affects-category
  const principles = [];
  graph.forEachNode((id, attrs) => {
    if (shown.has(id)) return;
    if (attrs.type === 'behavioral-principle' || attrs.type === 'topical-principle') principles.push({ id, ...attrs });
  });
  // Behavioral principles always included; topical fill remaining slots
  const behavioral = principles.filter(p => p.type === 'behavioral-principle');
  const topical = principles.filter(p => p.type !== 'behavioral-principle');
  behavioral.sort((a, b) => (b.weight || 0) - (a.weight || 0));
  topical.sort((a, b) => (b.pinned || 0) - (a.pinned || 0) || (b.weight || 0) - (a.weight || 0));
  const selected = [...behavioral, ...topical.slice(0, Math.max(0, maxDirectives - behavioral.length))];
  if (selected.length > 0) {
    let text = '## Principles\n';
    for (const d of selected) {
      // Check for resolved_from provenance edges
      let provenance = '';
      try {
        graph.forEachOutEdge(d.id, (key, attrs, source, target) => {
          if (attrs.type === 'resolved_from') {
            const targetNode = graph.getNodeAttributes(target);
            if (targetNode) provenance += (provenance ? ', ' : ' ← ') + targetNode.name;
          }
        });
      } catch {}
      text += `- **${d.name}**: ${firstSentence(d.content)}${provenance}\n`;
      shown.add(d.id);
    }
    sections.push(text.trim());
  }

  if (sections.length === 0) {
    return '# Memory\n\n(Graph is empty — run import to populate.)';
  }

  return '# Memory\n\n' + sections.join('\n\n');
}

function firstSentence(s) {
  if (!s) return '';
  const m = s.match(/^.*?[.!?](?:\s|$)/);
  return m ? m[0].trim() : truncate(s, 150);
}

function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
