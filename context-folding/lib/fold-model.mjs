/**
 * Fold model adapter — wraps different LLM APIs behind a unified interface.
 * Returns a function: ({ system, user }) => { text, tokensIn, tokensOut }
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Read the Anthropic OAuth token from OpenClaw's auth-profiles.
 * Direct API calls with OAuth token → Max subscription pricing, no gateway overhead.
 */
function getAnthropicOAuthToken() {
  try {
    const authPath = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
    const data = JSON.parse(readFileSync(authPath, 'utf-8'));
    const profileId = data.lastGood?.anthropic || 'anthropic:solsen2142';
    const token = data.profiles?.[profileId]?.token;
    if (token) return token;
  } catch {}
  return null;
}

// Pricing per million tokens (USD). Used for cost estimation even on subscription plans.
// Subscription models show "effective cost" — what you'd pay per-token. Useful for comparing methods.
const PRICING = {
  'gemini-flash':  { input: 0.15,  output: 0.60,  subscription: false },
  'gemini-3-flash': { input: 0.10, output: 0.40, subscription: false },
  'gemini-pro':    { input: 1.25,  output: 10.00, subscription: false },
  'sonnet':        { input: 3.00,  output: 15.00, subscription: true },
  'haiku':         { input: 0.80,  output: 4.00,  subscription: true },
  'kimi':          { input: 0.60,  output: 2.00,  subscription: false },
};

/**
 * Estimate cost in USD for a given model call.
 * Returns { costUsd, isSubscription } — subscription costs are notional (not actually billed per-token).
 */
export function estimateCost(modelName, tokensIn, tokensOut) {
  const p = PRICING[modelName];
  if (!p) return { costUsd: 0, isSubscription: false };
  const costUsd = (tokensIn * p.input + tokensOut * p.output) / 1_000_000;
  return { costUsd, isSubscription: p.subscription };
}

const MODEL_CONFIGS = {
  'gemini-flash': {
    provider: 'google',
    model: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GEMINI_API_KEY',
  },
  'gemini-3-flash': {
    provider: 'google',
    model: 'gemini-3-flash-preview',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GEMINI_API_KEY',
  },
  'gemini-pro': {
    provider: 'google',
    model: 'gemini-2.5-pro',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GEMINI_API_KEY',
  },
  'sonnet': {
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-4-5',
  },
  'haiku': {
    provider: 'anthropic-oauth',
    model: 'claude-haiku-4-5-20251001',
  },
  'sonnet-openrouter': {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4-5',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  },
  'kimi': {
    provider: 'openrouter',
    model: 'moonshotai/kimi-k2.5',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  },
};

export function createFoldModel(modelName) {
  const config = MODEL_CONFIGS[modelName];
  if (!config) throw new Error(`Unknown model: ${modelName}. Available: ${Object.keys(MODEL_CONFIGS).join(', ')}`);

  if (config.provider === 'anthropic-oauth') {
    const token = getAnthropicOAuthToken();
    if (!token) throw new Error('Could not read Anthropic OAuth token from auth-profiles.json');
    return createAnthropicOAuthModel(config, token);
  }

  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) throw new Error(`Missing env var: ${config.apiKeyEnv}`);

  if (config.provider === 'google') return createGeminiModel(config, apiKey);
  if (config.provider === 'anthropic') return createAnthropicModel(config, apiKey);
  if (config.provider === 'openrouter') return createOpenRouterModel(config, apiKey);
  throw new Error(`Unknown provider: ${config.provider}`);
}

/**
 * Direct Anthropic OAuth — calls api.anthropic.com with OAuth token.
 * Uses Max subscription pricing, no gateway overhead (~1s vs ~4.5s).
 */
function createAnthropicOAuthModel(config, token) {
  return async ({ system, user }) => {
    const start = Date.now();
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'anthropic-dangerous-direct-browser-access': 'true',
        'user-agent': 'claude-cli/2.1.2 (external, cli)',
        'x-app': 'cli',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 8192,
        temperature: 0.2,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic OAuth ${res.status}: ${errText.slice(0, 500)}`);
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || '';

    return {
      text,
      tokensIn: data.usage?.input_tokens || 0,
      tokensOut: data.usage?.output_tokens || 0,
      latencyMs: Date.now() - start,
    };
  };
}

function createGeminiModel(config, apiKey) {
  return async ({ system, user }) => {
    const url = `${config.baseUrl}/models/${config.model}:generateContent?key=${apiKey}`;
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    };

    const start = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini ${res.status}: ${errText.slice(0, 500)}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const usage = data.usageMetadata || {};

    return {
      text,
      tokensIn: usage.promptTokenCount || 0,
      tokensOut: usage.candidatesTokenCount || 0,
      latencyMs: Date.now() - start,
    };
  };
}

function createAnthropicModel(config, apiKey) {
  return async ({ system, user }) => {
    const start = Date.now();
    const res = await fetch(`${config.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey.startsWith('sk-ant-oat')
          ? { 'Authorization': `Bearer ${apiKey}` }
          : { 'x-api-key': apiKey }),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 4096,
        temperature: 0.2,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 500)}`);
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || '';

    return {
      text,
      tokensIn: data.usage?.input_tokens || 0,
      tokensOut: data.usage?.output_tokens || 0,
      latencyMs: Date.now() - start,
    };
  };
}

function createOpenRouterModel(config, apiKey) {
  return async ({ system, user }) => {
    const start = Date.now();
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 4096,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 500)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';

    return {
      text,
      tokensIn: data.usage?.prompt_tokens || 0,
      tokensOut: data.usage?.completion_tokens || 0,
      latencyMs: Date.now() - start,
    };
  };
}

export const availableModels = Object.keys(MODEL_CONFIGS);
