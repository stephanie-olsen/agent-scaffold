// embed-provider.mjs — Model-agnostic embedding interface.
// All graph scripts import from here. To change embedding models,
// edit data/embed-config.json and implement the provider below.

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, '../../data/embed-config.json');

let _config = null;
function getConfig() {
  if (!_config) _config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  return _config;
}

// --- Provider: Gemini ---
function geminiHeaders() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  return { key };
}

async function geminiEmbed(text, model) {
  const { key } = geminiHeaders();
  const fullModel = `models/${model}`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${fullModel}:embedContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: fullModel, content: { parts: [{ text }] } }),
    }
  );
  if (!res.ok) throw new Error(`Gemini embed API ${res.status}: ${await res.text()}`);
  return (await res.json()).embedding.values;
}

async function geminiBatchEmbed(texts, model) {
  const { key } = geminiHeaders();
  const fullModel = `models/${model}`;
  const requests = texts.map(text => ({ model: fullModel, content: { parts: [{ text }] } }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${fullModel}:batchEmbedContents?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }) }
  );
  if (!res.ok) throw new Error(`Gemini batch embed API ${res.status}: ${await res.text()}`);
  return (await res.json()).embeddings.map(e => e.values);
}

// --- Provider: Local server (e.g. nomic, qwen3 via embed-server.mjs) ---
async function localEmbed(text, model) {
  const port = 9099;
  const prefix = model.includes('nomic') ? 'search_query: ' : '';
  const res = await fetch(`http://localhost:${port}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: prefix + text })
  });
  if (!res.ok) throw new Error(`Local embed server ${res.status}`);
  return (await res.json()).vector;
}

async function localBatchEmbed(texts, model) {
  // Local server doesn't support batch — sequential fallback
  const results = [];
  for (const text of texts) results.push(await localEmbed(text, model));
  return results;
}

// --- Provider: OpenAI-compatible (OpenRouter, OpenAI, etc.) ---
async function openaiEmbed(text, model) {
  const key = process.env.OPENAI_API_KEY;
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, input: text })
  });
  if (!res.ok) throw new Error(`OpenAI embed API ${res.status}: ${await res.text()}`);
  return (await res.json()).data[0].embedding;
}

async function openaiBatchEmbed(texts, model) {
  const key = process.env.OPENAI_API_KEY;
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, input: texts })
  });
  if (!res.ok) throw new Error(`OpenAI embed API ${res.status}: ${await res.text()}`);
  return (await res.json()).data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

// --- Dispatch ---
const PROVIDERS = {
  gemini:  { embed: geminiEmbed, batch: geminiBatchEmbed },
  local:   { embed: localEmbed,  batch: localBatchEmbed },
  openai:  { embed: openaiEmbed, batch: openaiBatchEmbed },
};

function getProvider() {
  const config = getConfig();
  const provider = PROVIDERS[config.provider];
  if (!provider) throw new Error(`Unknown embed provider: ${config.provider}. Available: ${Object.keys(PROVIDERS).join(', ')}`);
  return { ...provider, model: config.model, dimensions: config.dimensions };
}

/**
 * Embed a single text string. Returns number[].
 */
export async function embedText(text) {
  const { embed, model } = getProvider();
  return embed(text, model);
}

/**
 * Embed multiple texts. Returns number[][].
 * Uses batch API where available.
 */
export async function batchEmbedTexts(texts) {
  const { batch, model } = getProvider();
  return batch(texts, model);
}

/**
 * Get current embedding config (for diagnostics/logging).
 */
export function getEmbedConfig() {
  return { ...getConfig() };
}
