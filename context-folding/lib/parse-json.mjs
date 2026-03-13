/**
 * Extract JSON from LLM output that may be wrapped in markdown code blocks.
 */
export function extractJson(text) {
  // Strip markdown code blocks
  let cleaned = text.replace(/^```(?:json)?\s*\n?/gm, '').replace(/\n?```\s*$/gm, '').trim();
  
  // Try parsing directly first
  try { return JSON.parse(cleaned); } catch {}
  
  // Try finding a JSON object/array
  const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  
  return null;
}
