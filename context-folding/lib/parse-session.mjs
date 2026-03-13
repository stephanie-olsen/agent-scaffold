/**
 * parse-session.mjs — Parse OpenClaw session JSONL into message arrays.
 * 
 * Session entries have type: "session" | "message" | "compaction" | "custom" | "model_change" | "thinking_level_change"
 * Messages are nested: { type: "message", message: { role, content, ... } }
 */

import { readFileSync } from 'fs';

/**
 * Parse a session JSONL file into an array of messages.
 * @param {string} filePath - Path to .jsonl file
 * @returns {{ messages: Array, metadata: Object }}
 */
export function parseSession(filePath) {
  const lines = readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
  const messages = [];
  let metadata = {};

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      
      if (entry.type === 'session') {
        metadata = { version: entry.version, id: entry.id, cwd: entry.cwd };
        continue;
      }
      
      if (entry.type === 'message' && entry.message) {
        const msg = entry.message;
        messages.push({
          index: messages.length,
          role: msg.role,
          content: extractText(msg),
          toolName: msg.toolName || null,
          timestamp: msg.timestamp || entry.timestamp,
          tokenEstimate: estimateTokens(msg),
          raw: msg,
        });
      }
    } catch (e) {
      // Skip malformed lines
    }
  }

  return { messages, metadata };
}

/**
 * Extract text content from a message for display/analysis.
 */
function extractText(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }
  // compactionSummary
  if (msg.summary) return msg.summary;
  return '';
}

/**
 * Rough token estimate (~4 chars per token).
 */
function estimateTokens(msg) {
  const text = extractText(msg);
  // Add overhead for tool calls, thinking blocks, etc.
  let extra = 0;
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'toolCall') {
        extra += Math.ceil(JSON.stringify(block.arguments || {}).length / 4);
      }
      if (block.type === 'thinking') {
        extra += Math.ceil((block.thinking || '').length / 4);
      }
    }
  }
  return Math.ceil(text.length / 4) + extra + 10; // 10 token overhead per message
}

/**
 * Get snapshots at specified token thresholds.
 * Returns array of { snapshotIndex, tokenCount, messageCount, messages }.
 */
export function getSnapshots(messages, thresholds = [0.5, 0.6, 0.7], contextWindow = 150000) {
  const snapshots = [];
  let cumTokens = 0;
  const thresholdTokens = thresholds.map(t => t * contextWindow);
  let nextThresholdIdx = 0;

  for (let i = 0; i < messages.length; i++) {
    cumTokens += messages[i].tokenEstimate;
    
    while (nextThresholdIdx < thresholdTokens.length && cumTokens >= thresholdTokens[nextThresholdIdx]) {
      snapshots.push({
        threshold: thresholds[nextThresholdIdx],
        messageIndex: i,
        tokenCount: cumTokens,
        messageCount: i + 1,
        messages: messages.slice(0, i + 1),
      });
      nextThresholdIdx++;
    }
  }

  return snapshots;
}

/**
 * Get total token count for a message array.
 */
export function totalTokens(messages) {
  return messages.reduce((sum, m) => sum + (m.tokenEstimate || 0), 0);
}
