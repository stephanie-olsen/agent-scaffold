import { extractJson } from '../parse-json.mjs';
/**
 * S3: Topic Segmentation
 * Detect topic boundaries via LLM. Summarize completed topics. Keep active topic verbatim.
 */

export async function fold(messages, opts) {
  const { minTopicSize = 3, promptStyle = 'conservative', foldModel } = opts;

  if (messages.length < minTopicSize * 2) {
    return { folded: messages, plan: { action: 'noop', reason: 'too few messages' }, foldTokensIn: 0, foldTokensOut: 0 };
  }

  const msgList = messages.map((m, i) => {
    const role = m.role === 'toolResult' ? `tool(${m.toolName || '?'})` : m.role;
    const preview = m.content.length > 200 ? m.content.slice(0, 150) + '...' : m.content;
    return `[${i}] ${role}: ${preview}`;
  }).join('\n');

  const aggressiveNote = promptStyle === 'aggressive'
    ? `For completed topic summaries: compress maximally. Keep ONLY re-work-preventing info. Target 2-3 sentences per topic.`
    : `For completed topic summaries: preserve key decisions, file paths, errors, and outcomes. Be thorough but concise.`;

  const result = await foldModel({
    system: `You are a conversation analyst. Identify distinct topics/tasks in this conversation, then summarize completed ones.

A topic is a coherent unit of work or discussion. Minimum ${minTopicSize} messages per topic.
The LAST topic is considered "active" — return its message indices.

${aggressiveNote}

Respond with JSON only:
{
  "topics": [
    { "name": "topic name", "range": [startIdx, endIdx], "status": "completed"|"active", "summary": "..." }
  ]
}
For active topics, summary can be empty. All messages must be covered. No gaps.`,
    user: `Conversation (${messages.length} messages):\n\n${msgList}`,
  });

  const plan = extractJson(result.text);
  if (!plan || !plan.topics) {
    return { folded: messages, plan: { action: 'parse-error', raw: result.text.slice(0, 500) }, foldTokensIn: result.tokensIn || 0, foldTokensOut: result.tokensOut || 0 };
  }

  const folded = [];
  for (const topic of plan.topics) {
    if (topic.status === 'active') {
      const start = topic.range[0];
      const end = Math.min(topic.range[1], messages.length - 1);
      for (let i = start; i <= end; i++) {
        folded.push({ ...messages[i], index: folded.length });
      }
    } else {
      folded.push({
        index: folded.length,
        role: 'compactionSummary',
        content: `[topic: ${topic.name}] ${topic.summary}`,
        timestamp: messages[topic.range[1]]?.timestamp,
        tokenEstimate: Math.ceil((topic.summary || '').length / 4) + 15,
        raw: { role: 'compactionSummary', summary: topic.summary, topicName: topic.name },
      });
    }
  }

  return {
    folded,
    plan: {
      action: 'topic-segmentation',
      topics: plan.topics.map(t => ({ name: t.name, status: t.status, range: t.range })),
      summarizedTopics: plan.topics.filter(t => t.status === 'completed').length,
      activeTopicMessages: plan.topics.filter(t => t.status === 'active').reduce((s, t) => s + (t.range[1] - t.range[0] + 1), 0),
    },
    foldTokensIn: result.tokensIn || 0,
    foldTokensOut: result.tokensOut || 0,
  };
}
