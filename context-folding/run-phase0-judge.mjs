#!/usr/bin/env node
/**
 * Phase 0: Judge compaction summary quality.
 * Feeds original messages + compaction summary to Sonnet, scores on 4 dimensions.
 * Compares against human ratings for calibration.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createFoldModel } from './lib/fold-model.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HUMAN_RATINGS = [
  { sample: 1, rating: 5.0, notes: "Good" },
  { sample: 2, rating: 2.0, notes: "Includes irrelevant instructions, goals combine separate threads" },
  { sample: 3, rating: 4.0, notes: "Fine summary despite session type label" },
  { sample: 4, rating: 4.5, notes: "Good but refers to 'the assistant', heavily concentrated" },
  { sample: 5, rating: 4.0, notes: "Good context preservation" },
  { sample: 6, rating: 2.0, notes: "Muddled goals, massive progress section spanning multiple threads" },
  { sample: 7, rating: 4.0, notes: "Multiple threads handled well" },
  { sample: 8, rating: 2.5, notes: "Bloated done, 13 next steps unactionable" },
  { sample: 9, rating: 3.0, notes: "Lumps unrelated work into same sections" },
  { sample: 10, rating: null, notes: "Duplicate of #9, skip" },
];

const JUDGE_PROMPT = `You are evaluating a compaction summary — a compressed version of a conversation that will replace the original messages in the agent's context window. The agent will continue working with ONLY this summary plus recent messages.

You will see:
1. ORIGINAL MESSAGES: The actual conversation that was compacted (may be very long, skim for topic structure)
2. COMPACTION SUMMARY: What replaced those messages

Score each dimension 0.0 to 1.0:

- **thread_coherence**: Were there distinct topics/threads in the original? If so, does the summary keep them separated, or does it mush them into one narrative? Multiple unrelated goals listed under a single "Goal" heading = low score. (1.0 = distinct threads clearly separated; 0.0 = everything muddled together)

- **signal_to_noise**: Does the summary contain content that shouldn't be there? Stale instructions, irrelevant implementation details, verbatim error messages that don't matter anymore, meta-instructions about how the agent should behave? (1.0 = only relevant information preserved; 0.0 = full of noise)

- **actionability**: Could someone pick up this summary and continue the work? Are next steps clear? Is the current state of each task obvious? Or is it a wall of bullets that's hard to parse? (1.0 = could immediately continue working; 0.0 = would need to re-read original conversation)

- **factual_accuracy**: Does the summary misrepresent what happened? Are decisions attributed correctly? Are file paths, numbers, and technical details accurate? (1.0 = fully accurate; 0.0 = contains fabrications or significant errors)

Be critical. A summary that preserves facts but mushes topics together should score high on factual_accuracy but low on thread_coherence.

Respond with JSON only:
{
  "thread_coherence": 0.0,
  "signal_to_noise": 0.0,
  "actionability": 0.0,
  "factual_accuracy": 0.0,
  "notes": "brief explanation of scores"
}`;

async function main() {
  const samples = JSON.parse(readFileSync(join(__dirname, 'compaction-samples.json'), 'utf8'));
  const judge = createFoldModel('sonnet');
  
  const results = [];
  
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const human = HUMAN_RATINGS[i];
    
    if (human.rating === null) {
      console.log(`\nSample ${i + 1}: SKIPPED (${human.notes})`);
      continue;
    }
    
    console.log(`\nSample ${i + 1}: ${sample.sessionType} (${sample.tokensBefore.toLocaleString()} tokens)`);
    console.log(`  Human rating: ${human.rating}/5 — ${human.notes}`);
    
    // Build original messages text from prior messages
    // Note: priorMessages only has last 5 — for a proper eval we need more context
    // But the summary itself tells us what topics were covered, so the judge can 
    // assess structure even from the summary alone (thread coherence, actionability, noise)
    const priorContext = sample.priorMessages.map(m => 
      `[${m.type}]: ${m.contentPreview}`
    ).join('\n\n');
    
    // For thread coherence, the summary itself reveals whether topics are separated.
    // For factual accuracy, we'd ideally need full original — but we can assess 
    // internal consistency and obvious errors from the summary alone.
    // Mark this limitation.
    
    const userPrompt = `LAST MESSAGES BEFORE COMPACTION (partial — only last 5 shown):
${priorContext || '(no prior messages captured)'}

COMPACTION SUMMARY (${sample.summaryLength.toLocaleString()} chars, replacing ${sample.tokensBefore.toLocaleString()} tokens):
${sample.summary}`;

    try {
      const result = await judge({
        system: JUDGE_PROMPT,
        user: userPrompt,
      });
      
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      const scores = JSON.parse(jsonMatch[0]);
      
      const mean = (scores.thread_coherence + scores.signal_to_noise + scores.actionability + scores.factual_accuracy) / 4;
      // Normalize to 1-5 scale for comparison
      const normalized = mean * 4 + 1;
      
      console.log(`  Judge scores: thread=${scores.thread_coherence} noise=${scores.signal_to_noise} action=${scores.actionability} factual=${scores.factual_accuracy}`);
      console.log(`  Judge mean: ${mean.toFixed(3)} (≈${normalized.toFixed(1)}/5) | Human: ${human.rating}/5 | Δ=${Math.abs(normalized - human.rating).toFixed(1)}`);
      console.log(`  Notes: ${scores.notes}`);
      
      results.push({
        sample: i + 1,
        sessionType: sample.sessionType,
        tokensBefore: sample.tokensBefore,
        humanRating: human.rating,
        humanNotes: human.notes,
        judgeScores: scores,
        judgeMean: mean,
        judgeNormalized: normalized,
        delta: Math.abs(normalized - human.rating),
        judgeTokensIn: result.tokensIn,
        judgeTokensOut: result.tokensOut,
      });
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
      results.push({
        sample: i + 1,
        sessionType: sample.sessionType,
        error: e.message,
        humanRating: human.rating,
      });
    }
  }
  
  // Summary statistics
  const valid = results.filter(r => r.judgeMean != null);
  if (valid.length > 0) {
    const meanDelta = valid.reduce((a, r) => a + r.delta, 0) / valid.length;
    
    // Pearson correlation between human ratings and judge means
    const humanScores = valid.map(r => r.humanRating);
    const judgeScores = valid.map(r => r.judgeNormalized);
    const n = humanScores.length;
    const meanH = humanScores.reduce((a, b) => a + b, 0) / n;
    const meanJ = judgeScores.reduce((a, b) => a + b, 0) / n;
    let num = 0, denH = 0, denJ = 0;
    for (let i = 0; i < n; i++) {
      num += (humanScores[i] - meanH) * (judgeScores[i] - meanJ);
      denH += (humanScores[i] - meanH) ** 2;
      denJ += (judgeScores[i] - meanJ) ** 2;
    }
    const correlation = (denH > 0 && denJ > 0) ? num / Math.sqrt(denH * denJ) : 0;
    
    // Rank correlation (Spearman)
    const rank = arr => {
      const sorted = [...arr].sort((a, b) => a - b);
      return arr.map(v => sorted.indexOf(v) + 1);
    };
    const rankH = rank(humanScores);
    const rankJ = rank(judgeScores);
    let numR = 0, denRH = 0, denRJ = 0;
    const meanRH = rankH.reduce((a, b) => a + b, 0) / n;
    const meanRJ = rankJ.reduce((a, b) => a + b, 0) / n;
    for (let i = 0; i < n; i++) {
      numR += (rankH[i] - meanRH) * (rankJ[i] - meanRJ);
      denRH += (rankH[i] - meanRH) ** 2;
      denRJ += (rankJ[i] - meanRJ) ** 2;
    }
    const spearman = (denRH > 0 && denRJ > 0) ? numR / Math.sqrt(denRH * denRJ) : 0;
    
    console.log(`\n=== CALIBRATION SUMMARY ===`);
    console.log(`Samples judged: ${valid.length}`);
    console.log(`Mean absolute delta (judge vs human): ${meanDelta.toFixed(2)}`);
    console.log(`Pearson correlation: ${correlation.toFixed(3)}`);
    console.log(`Spearman rank correlation: ${spearman.toFixed(3)}`);
    console.log(`\nPer-dimension averages:`);
    
    const dims = ['thread_coherence', 'signal_to_noise', 'actionability', 'factual_accuracy'];
    for (const dim of dims) {
      const vals = valid.map(r => r.judgeScores[dim]).filter(v => typeof v === 'number');
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      console.log(`  ${dim}: ${mean.toFixed(3)}`);
    }
  }
  
  writeFileSync(join(__dirname, 'phase0-calibration.json'), JSON.stringify(results, null, 2));
  console.log(`\nSaved: phase0-calibration.json`);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
