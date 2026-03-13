// gemini-embed.mjs — Shared Gemini embedding function for all graph scripts.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'models/gemini-embedding-001';

export async function embedText(text) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GEMINI_MODEL, content: { parts: [{ text }] } }),
    }
  );
  if (!res.ok) throw new Error(`Gemini embed API ${res.status}: ${await res.text()}`);
  return (await res.json()).embedding.values;
}

export async function batchEmbedTexts(texts) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const requests = texts.map(text => ({ model: GEMINI_MODEL, content: { parts: [{ text }] } }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:batchEmbedContents?key=${GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }) }
  );
  if (!res.ok) throw new Error(`Gemini batch embed API ${res.status}: ${await res.text()}`);
  return (await res.json()).embeddings.map(e => e.values);
}
