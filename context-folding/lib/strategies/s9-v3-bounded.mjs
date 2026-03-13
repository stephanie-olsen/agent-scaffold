import { extractJson } from '../parse-json.mjs';
/**
 * S9-v3: Topic Segmentation + ACON Constraints + Bounded Growth
 * 
 * Same as S9 but with two additions:
 * 1. Instruction to drop completed topics from previous summaries when they're
 *    not referenced by any active topic
 * 2. Token budget on the output summary itself (not just relative to input)
 * 
 * For testing against S9 baseline in the fold harness.
 */

const PRESERVATION_GUARDRAILS = `
When summarizing completed topics, ALWAYS preserve these if present:
- File paths, directory names, config values mentioned
- Decisions made and WHY (not just what was decided)
- Errors encountered and what fix worked
- User corrections or stated preferences
- Current in-progress state (what step, what remains)

These are guardrails for HOW to summarize, not WHETHER to compress. You MUST compress.`;

const PREVIOUS_SUMMARY_HANDLING = `
HANDLING PREVIOUS SUMMARIES:
When a <previous-summary> is provided, it contains topics from earlier folds.
- DROP completed topics from the previous summary that are not referenced by any active topic.
- Keep everything else — active topics, completed topics that active work depends on.
- If a previously active topic is now resolved, move it to COMPLETED with its outcome.

The previous summary is context to integrate, not content to preserve wholesale.`;

export async function fold(messages, opts) {
  const {
    promptStyle = 'conservative',
    foldModel,
    keepRecent = 5,
    previousSummary = null,
    maxSummaryTokens = 10000,
  } = opts;

  const keepFrom = (opts.maxKeepTokens ? findExchangeBoundaryTokenCapped : findExchangeBoundary)(messages, keepRecent, opts.maxKeepTokens);
  if (keepFrom <= 2) {
    return { folded: messages, plan: { action: 'noop', reason: 'too few messages' }, foldTokensIn: 0, foldTokensOut: 0 };
  }

  const recentMessages = messages.slice(keepFrom);
  const olderMessages = messages.slice(0, keepFrom);

  // Pre-process: collapse tool call/result pairs
  const processed = collapseToolPairs(olderMessages);

  const formatted = processed.map((m, i) => {
    const content = m.content.length > 2000 ? m.content.slice(0, 1500) + '...[truncated]' : m.content;
    return `[${i}] ${m.role}: ${content}`;
  }).join('\n');

  const inputTokens = olderMessages.reduce((s, m) => s + (m.tokenEstimate || Math.ceil(m.content.length / 4)), 0);
  const tokenBudget = Math.min(Math.round(inputTokens * 0.25), maxSummaryTokens);

  const aggressiveNote = promptStyle === 'aggressive'
    ? `Target ≤${tokenBudget} tokens total output. Compress ruthlessly. 1 sentence per completed topic.`
    : `Target ≤${tokenBudget} tokens total output. 2-3 sentences per completed topic. Active topic gets more detail.`;

  let userPrompt = `Messages to compress (${processed.length} messages, ~${inputTokens} tokens → target ≤${tokenBudget} tokens):\n\n${formatted}`;
  
  if (previousSummary) {
    userPrompt += `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>`;
  }
  
  userPrompt += '\n\nRespond with the JSON object now:';

  const result = await foldModel({
    system: `You are a context compressor that works in three steps:

STEP 1 — SEGMENT: Identify distinct topics/tasks in the conversation. A topic is a coherent unit of work or discussion (e.g., "debugging auth flow", "discussing book recommendations", "configuring cron jobs"). Mark each as COMPLETED or ACTIVE.

STEP 2 — COMPRESS: 
- COMPLETED topics: Summarize with key outcomes, preserving critical details per guardrails below.
- ACTIVE topic (most recent incomplete work): Keep more detail — what's being worked on, current state, next steps.
- If the conversation is discussion-heavy (philosophy, planning, brainstorming): topics are threads of argument. Preserve conclusions, disagreements, and open questions.

STEP 3 — PENDING ACTION: Separately capture what was about to happen next. This is the most recent user request and what the assistant was doing or about to do in response. Include specific tool calls, commands, or actions in flight. This must be precise enough that a fresh model could pick up exactly where the conversation left off.

${PRESERVATION_GUARDRAILS}
${previousSummary ? `\n${PREVIOUS_SUMMARY_HANDLING}\n\nHARD LIMIT: Your entire response must be ≤${maxSummaryTokens} tokens (~8000 words). If you cannot fit everything, drop the oldest completed topics first.\n` : ''}
${aggressiveNote}

You MUST respond with a JSON object and nothing else. No markdown, no explanation, no headers. Raw JSON only.
The JSON schema is: {"topics": [{"name": "string", "status": "completed|active", "summary": "string"}], "pendingAction": {"lastUserRequest": "string", "assistantState": "string"}}`,
    user: userPrompt,
  });

  const parsed = extractJson(result.text);
  if (!parsed || !parsed.topics || !Array.isArray(parsed.topics)) {
    console.error('S9-v3 parse error. Raw output (first 500 chars):', result.text?.slice(0, 500));
    console.error('tokensOut:', result.tokensOut, 'textLength:', result.text?.length);
    return { folded: messages, plan: { action: 'parse-error' }, foldTokensIn: result.tokensIn || 0, foldTokensOut: result.tokensOut || 0 };
  }

  // Build folded output
  const folded = [];

  for (const topic of parsed.topics) {
    const prefix = topic.status === 'active' ? '[active-topic]' : '[completed-topic]';
    const text = `${prefix} ${topic.name}: ${topic.summary}`;
    folded.push({
      index: folded.length,
      role: 'compactionSummary',
      content: text,
      timestamp: null,
      tokenEstimate: Math.ceil(text.length / 4) + 10,
      raw: { role: 'compactionSummary', strategy: 's9-v3', topic: topic.name, status: topic.status },
    });
  }

  if (parsed.pendingAction) {
    const pa = parsed.pendingAction;
    const paText = `[pending-action] User requested: ${pa.lastUserRequest || 'unknown'}\nAssistant state: ${pa.assistantState || 'unknown'}`;
    folded.push({
      index: folded.length,
      role: 'compactionSummary',
      content: paText,
      timestamp: null,
      tokenEstimate: Math.ceil(paText.length / 4) + 10,
      raw: { role: 'compactionSummary', strategy: 's9-v3', section: 'pendingAction' },
    });
  }

  for (const m of recentMessages) {
    folded.push({ ...m, index: folded.length });
  }

  return {
    folded,
    plan: {
      action: 'topic-constrained-v3',
      topicCount: parsed.topics.length,
      completedTopics: parsed.topics.filter(t => t.status === 'completed').length,
      activeTopics: parsed.topics.filter(t => t.status === 'active').length,
    },
    foldTokensIn: result.tokensIn || 0,
    foldTokensOut: result.tokensOut || 0,
  };
}

function collapseToolPairs(messages) {
  const collapsed = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    const hasToolCall = (m.role === 'assistant' && m.content === '' && Array.isArray(m.raw?.content) && 
      m.raw.content.some(b => b.type === 'toolCall' || b.type === 'tool_use'));
    
    if (hasToolCall) {
      const tools = m.raw.content.filter(b => b.type === 'toolCall' || b.type === 'tool_use');
      const toolSummaries = tools.map(t => {
        const name = t.name || t.toolName || 'unknown';
        const args = t.input || t.arguments || {};
        const argStr = typeof args === 'string' ? args.slice(0, 200) : JSON.stringify(args).slice(0, 200);
        return `${name}(${argStr})`;
      });
      
      let resultSummary = '';
      if (i + 1 < messages.length && (messages[i + 1].role === 'toolResult' || messages[i + 1].role === 'tool')) {
        const result = messages[i + 1].content || '';
        resultSummary = ' → ' + (result.length > 200 ? result.slice(0, 150) + '...' : result);
        i++;
      }
      
      collapsed.push({
        role: 'action',
        content: toolSummaries.join('; ') + resultSummary,
        tokenEstimate: Math.ceil((toolSummaries.join('; ') + resultSummary).length / 4),
      });
    } else {
      collapsed.push(m);
    }
    i++;
  }
  return collapsed;
}

function findExchangeBoundary(messages, n) {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      count++;
      if (count >= n) return i;
    }
  }
  return 0;
}

export function findExchangeBoundaryTokenCapped(messages, n, maxTokens) {
  if (!maxTokens) return findExchangeBoundary(messages, n);
  let count = 0;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    tokens += messages[i].tokenEstimate || Math.ceil((messages[i].content || '').length / 4);
    if (tokens > maxTokens) return i + 1;
    if (messages[i].role === 'user') { count++; if (count >= n) return i; }
  }
  return 0;
}
