import { extractJson } from '../parse-json.mjs';
/**
 * S5: Unified Folding (tool results included)
 * Same as S2 but tool results are NOT pre-pruned. Folding model sees full tool outputs.
 */

export async function fold(messages, opts) {
  const { keepRecent = 5, summaryLengthTarget = 500, promptStyle = 'conservative', foldModel } = opts;

  const keepFrom = (opts.maxKeepTokens ? findExchangeBoundaryTokenCapped : findExchangeBoundary)(messages, keepRecent, opts.maxKeepTokens);
  if (keepFrom <= 2) {
    return { folded: messages, plan: { action: 'noop', reason: 'too few messages' }, foldTokensIn: 0, foldTokensOut: 0 };
  }

  const foldable = messages.slice(0, keepFrom);
  const kept = messages.slice(keepFrom);

  const msgList = foldable.map((m, i) => {
    const role = m.role === 'toolResult' ? `tool(${m.toolName || '?'})` : m.role;
    const maxLen = m.role === 'toolResult' ? 2000 : 300;
    const preview = m.content.length > maxLen ? m.content.slice(0, maxLen * 0.7 | 0) + '\n...[' + m.content.length + ' chars]...\n' + m.content.slice(-maxLen * 0.2 | 0) : m.content;
    return `[${i}] ${role}: ${preview}`;
  }).join('\n');

  const aggressiveInstructions = promptStyle === 'aggressive'
    ? `Compress maximally. Target ${summaryLengthTarget} chars per group. For tool outputs: extract ONLY actionable findings.`
    : `Preserve important information. Target ${summaryLengthTarget} chars per group. For tool outputs: keep errors, key findings, file paths.`;

  const result = await foldModel({
    system: `You are a context compression planner. Given a conversation with full tool outputs, group related messages and produce a summary for each group.

IMPORTANT: Tool results contain raw output. Extract what matters and discard the rest.

${aggressiveInstructions}

Respond with JSON only:
{
  "groups": [
    { "range": [startIdx, endIdx], "summary": "..." },
    ...
  ]
}
Each group covers a contiguous range. All messages must be covered exactly once.`,
    user: `Messages to fold (${foldable.length} messages, including full tool outputs):\n\n${msgList}`,
  });

  let plan = extractJson(result.text);
  if (!plan) plan = { groups: [{ range: [0, foldable.length - 1], summary: result.text }] };

  const summaryMessages = plan.groups.map((g, i) => ({
    index: i,
    role: 'compactionSummary',
    content: `[fold:${g.range[0]}-${g.range[1]}] ${g.summary}`,
    timestamp: foldable[g.range[1]]?.timestamp,
    tokenEstimate: Math.ceil(g.summary.length / 4) + 10,
    raw: { role: 'compactionSummary', summary: g.summary, range: g.range },
  }));

  const folded = [
    ...summaryMessages,
    ...kept.map((m, i) => ({ ...m, index: summaryMessages.length + i })),
  ];

  return {
    folded,
    plan: { action: 'unified-folding', groups: plan.groups.length, summarizedCount: foldable.length, keptCount: kept.length },
    foldTokensIn: result.tokensIn || 0,
    foldTokensOut: result.tokensOut || 0,
  };
}

function findExchangeBoundary(messages, n) {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { count++; if (count >= n) return i; }
  }
  return 0;
}

// Token-bounded variant: keep last N user exchanges but cap at maxTokens
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
