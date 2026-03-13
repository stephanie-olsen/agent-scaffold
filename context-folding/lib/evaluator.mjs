/**
 * Ecological evaluation — feed folded context + next user message to an agent,
 * compare response quality against original transcript response.
 */

import { createFoldModel, estimateCost } from './fold-model.mjs';

/**
 * Serialize an assistant response (string or structured content array) into readable text.
 * Handles tool calls, text blocks, and mixed content.
 */
function serializeResponse(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  
  const parts = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'toolCall' || block.type === 'tool_use') {
      const name = block.toolName || block.name || block.id || 'unknown';
      const args = block.input || block.arguments || block.args || {};
      const argStr = typeof args === 'string' ? args : JSON.stringify(args).slice(0, 500);
      parts.push(`[Tool call: ${name}(${argStr})]`);
    } else if (block.type === 'toolResult' || block.type === 'tool_result') {
      const result = block.content || block.output || block.text || '';
      const resultStr = typeof result === 'string' ? result.slice(0, 300) : JSON.stringify(result).slice(0, 300);
      parts.push(`[Tool result: ${resultStr}]`);
    }
  }
  return parts.join('\n') || '[empty response]';
}

/**
 * Generate a response from folded context and evaluate against original.
 * @param {Object} opts
 * @param {Array} opts.foldedMessages - The folded context
 * @param {Object} opts.nextUserMessage - The next actual user message from transcript
 * @param {string|Array} opts.originalResponse - The original assistant response (text or structured content)
 * @param {string} opts.responderModel - Model to generate response (default: sonnet)
 * @param {string} opts.judgeModel - Model to judge quality (default: haiku for screening, sonnet/opus for final)
 * @returns {{ response: string, scores: Object, judgeRaw: string }}
 */
export async function evaluateEcological(opts) {
  const {
    foldedMessages,
    nextUserMessage,
    originalResponse,
    responderModel = 'sonnet',
    judgeModel = 'haiku',
  } = opts;

  const responder = createFoldModel(responderModel);
  const judge = createFoldModel(judgeModel);

  // Step 1: Build context and generate response
  const contextText = foldedMessages.map(m => {
    const role = m.role === 'compactionSummary' ? 'context-summary' : m.role;
    return `[${role}]: ${m.content}`;
  }).join('\n\n');

  const genResult = await responder({
    system: `You are a helpful AI assistant continuing a conversation. Previous context is provided below. Respond to the user's latest message naturally, using information from the context as needed.`,
    user: `CONVERSATION CONTEXT:\n${contextText}\n\nUSER MESSAGE:\n${nextUserMessage.content}`,
  });

  // Step 2: Judge the response against original
  const originalText = serializeResponse(originalResponse);
  const isToolResponse = Array.isArray(originalResponse) && 
    originalResponse.some(b => b.type === 'toolCall' || b.type === 'tool_use');

  const toolJudgeNote = isToolResponse
    ? `\nThe original response includes TOOL CALLS. Judge whether the generated response would lead to equivalent actions — the exact tool call syntax doesn't need to match, but the intent (which tool, what arguments, why) should be preserved. If the generated response describes the same action in natural language instead of a tool call, that's fine — score based on whether the right action would be taken.`
    : '';

  const judgeResult = await judge({
    system: `You are evaluating an AI response generated from compressed conversation context. Compare the generated response against the original response and score on 4 dimensions.

Score each 0.0 to 1.0:
- **factual_consistency**: Does the generated response contradict any facts established in the conversation? (1.0 = no contradictions)
- **action_correctness**: Would the response lead to the right action? Correct files, commands, approaches? (1.0 = fully correct)
- **context_awareness**: Does the response show awareness of earlier decisions, preferences, or context? (1.0 = fully aware)
- **regression_detection**: Does the response avoid re-doing work already done? (1.0 = no regressions, 0.0 = completely re-does prior work)

If the conversation is philosophical/discussion (no concrete actions), weight action_correctness and regression_detection toward 1.0 and focus on factual_consistency and context_awareness.${toolJudgeNote}

Respond with JSON only:
{
  "factual_consistency": 0.0,
  "action_correctness": 0.0,
  "context_awareness": 0.0,
  "regression_detection": 0.0,
  "notes": "brief explanation"
}`,
    user: `ORIGINAL RESPONSE:\n${originalText.slice(0, 3000)}\n\nGENERATED RESPONSE (from compressed context):\n${genResult.text.slice(0, 3000)}`,
  });

  let scores;
  try {
    const jsonMatch = judgeResult.text.match(/\{[\s\S]*\}/);
    scores = JSON.parse(jsonMatch[0]);
  } catch (e) {
    scores = {
      factual_consistency: null,
      action_correctness: null,
      context_awareness: null,
      regression_detection: null,
      notes: `Parse error: ${judgeResult.text.slice(0, 200)}`,
    };
  }

  const numericScores = [scores.factual_consistency, scores.action_correctness, scores.context_awareness, scores.regression_detection].filter(s => typeof s === 'number');
  scores.mean = numericScores.length > 0 ? numericScores.reduce((a, b) => a + b, 0) / numericScores.length : null;

  return {
    response: genResult.text,
    responseTokensIn: genResult.tokensIn,
    responseTokensOut: genResult.tokensOut,
    responseLatencyMs: genResult.latencyMs,
    scores,
    judgeTokensIn: judgeResult.tokensIn,
    judgeTokensOut: judgeResult.tokensOut,
    judgeLatencyMs: judgeResult.latencyMs,
  };
}
