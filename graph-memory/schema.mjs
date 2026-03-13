// schema.mjs — Type definitions and validation for graph memory

export const NODE_TYPES = new Set([
  'entity', 'concept', 'event', 'lesson', 'task',
  // Extended types (graph-type-expansion)
  'decision',   // A choice made with reasoning (why we did X)
  'preference', // User preference or stated value
  'behavioral-principle',  // Always-active guiding principle — prevents recurring failures regardless of topic
  'topical-principle',     // Guiding principle that surfaces through search when topic-relevant
  'problem',    // An unresolved issue or friction point
  'impression', // First-person response to a work/moment — emotional, unprocessed, anchored to source
  'held-contradiction', // Positions held simultaneously without resolution — the holding is the content
]);

export const EDGE_TYPES = new Set([
  // Original core types
  'relates_to', 'derived_from', 'contradicts',
  'supersedes', 'led_to', 'involves',
  // Structural types
  'part_of', 'extends', 'requires', 'enables', 'precedes',
  // Intellectual types
  'exemplifies', 'inspired_by', 'critiques',
  // Tension types
  'resonates_with', 'tension_with', 'persists_against',
  // Additional
  'supports',
  // Provenance
  'resolved_from',
  // Error preservation (Talmud model: preserve why positions lost)
]);

export const TRUST_LEVELS = new Set(['direct', 'derived', 'external', 'unverified']);

/**
 * Create a node with defaults filled in.
 * @param {object} props - Node properties (id, type, name required)
 * @returns {object} Complete node object
 */
export function createNode(props) {
  if (!props.id) throw new Error('Node id required');
  if (!props.type || !NODE_TYPES.has(props.type)) {
    throw new Error(`Invalid node type: ${props.type}. Must be one of: ${[...NODE_TYPES].join(', ')}`);
  }
  if (!props.name) throw new Error('Node name required');

  const now = Date.now();
  return {
    id: props.id,
    type: props.type,
    name: props.name,
    content: props.content || '',
    source: props.source || 'unknown',
    trust: TRUST_LEVELS.has(props.trust) ? props.trust : 'direct',
    created_at: props.created_at || now,
    updated_at: props.updated_at || now,
    last_accessed: props.last_accessed || now,
    access_count: props.access_count || 0,
    weight: props.weight ?? 1.0,
    pinned: props.pinned || false,
    tags: Array.isArray(props.tags) ? props.tags : [],
    // Feedback counters
    helpful_count: props.helpful_count || 0,
    harmful_count: props.harmful_count || 0,
    // Task-specific
    ...(props.type === 'task' ? { status: props.status || 'active', schedule: props.schedule || '' } : {})
  };
}

/**
 * Create an edge with defaults.
 * @param {object} props - Edge properties (source, target, type required)
 * @returns {object} Complete edge object
 */
export function createEdge(props) {
  if (!props.source) throw new Error('Edge source required');
  if (!props.target) throw new Error('Edge target required');
  if (!props.type || !EDGE_TYPES.has(props.type)) {
    throw new Error(`Invalid edge type: ${props.type}. Must be one of: ${[...EDGE_TYPES].join(', ')}`);
  }

  return {
    source: props.source,
    target: props.target,
    type: props.type,
    subtype: props.subtype || null,        // semantic subtype (from EDGE_SUBTYPES) — richer meaning without graph complexity
    context: props.context || '',           // factual content lives here — treat as primary, not annotation
    weight: props.weight ?? 1.0,
    created_at: props.created_at || Date.now(),
    valid_from: props.valid_from || null,   // temporal: when this fact became true (unix ms, null = always)
    valid_until: props.valid_until || null,  // temporal: when this fact stopped being true (null = still valid)
  };
}

/**
 * Validate a node object (for imports or updates).
 */
export function validateNode(node) {
  const errors = [];
  if (!node.id) errors.push('missing id');
  if (!NODE_TYPES.has(node.type)) errors.push(`invalid type: ${node.type}`);
  if (!node.name) errors.push('missing name');
  if (node.trust && !TRUST_LEVELS.has(node.trust)) errors.push(`invalid trust: ${node.trust}`);
  if (node.weight != null && (node.weight < 0 || node.weight > 1)) errors.push(`weight out of range: ${node.weight}`);
  return errors.length ? errors : null;
}
