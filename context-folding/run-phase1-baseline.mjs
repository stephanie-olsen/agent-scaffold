#!/usr/bin/env node
/**
 * Phase 1: Baseline measurement.
 * 
 * For each compaction sample, measures:
 *   1. Quality score (1-5) via simplified Sonnet judge
 *   2. Compression ratio (tokens before / summary chars → effective tokens)
 *   3. Summary size (chars and estimated tokens)
 *   4. Latency — not measurable from historical samples (marked N/A)
 * 
 * Also computes correlation with human+agent ratings from Phase 0.
 * 
 * Usage:
 *   node run-phase1-baseline.mjs [--dry-run] [--sample N] [--verbose]
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { createFoldModel, estimateCost } from './lib/fold-model.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    'sample': { type: 'string' },
    'verbose': { type: 'boolean', default: false },
  },
  strict: false,
});

// Human + agent ratings from Phase 0 calibration
const PHASE0_RATINGS = [
  { sample: 1, steph: 5.0, thresh: 3.5 },
  { sample: 2, steph: 2.0, thresh: 2.0 },
  { sample: 3, steph: 4.0, thresh: 3.0 },
  { sample: 4, steph: 4.5, thresh: 4.0 },
  { sample: 5, steph: 4.0, thresh: 1.5 },
  { sample: 6, steph: 2.0, thresh: 2.0 },
  { sample: 7, steph: 4.0, thresh: 4.0 },
  { sample: 8, steph: 2.5, thresh: 2.5 },
  { sample: 9, steph: 3.0, thresh: 3.0 },
  { sample: 10, steph: null, thresh: 2.5 },
];

const JUDGE_PROMPT = `You are evaluating a compaction summary — a compressed version of a long AI agent conversation that will replace the original messages in the agent's context window.

After compaction, the agent will wake up with ONLY this summary (plus a system prompt and recent messages). It needs to continue working effectively.

Rate this summary 1-5:

5 = Excellent. Agent could immediately continue all active work. Clear what's done, what's in progress, what to do next. Multiple topics (if any) are clearly separated.
4 = Good. Agent could continue most work with minor confusion. Maybe one thread is unclear or a next step is ambiguous.
3 = Adequate. Agent could figure out what to do but would waste time re-orienting. Important context is present but poorly organized.
2 = Poor. Agent would be significantly confused. Topics are muddled together, priorities unclear, or important active work is buried/missing.
1 = Unusable. Agent would essentially need to start over. Critical context is lost or so disorganized it's faster to ask than to parse.

Key things to evaluate:
- Could you tell what the agent was ACTIVELY doing (not just what's done)?
- If there were multiple unrelated workstreams, are they distinguishable?
- Are next steps actionable (specific enough to act on) or vague?
- Is there noise (stale instructions, irrelevant details, meta-commentary)?

CRITICAL: Information completeness is NOT the same as usability. A summary with 8 goals and 13 next steps may contain everything but is HARDER to work from than one with 2 goals and 3 clear next steps. Penalize summaries that overwhelm with detail — the agent needs to orient quickly, not read a novel. Length is a cost, not a feature.

CALIBRATION EXAMPLES (human-rated):

Example A (rated 4.5/5 by humans): A single-topic summary about experiment pipeline work. Clear what's running (attractor experiments, 4/50 and 0/30 complete), what failed (relay script BOM encoding), what to do next (monitor experiments, check Gemini anomaly). One thread, easy to orient.

Example B (rated 2.0/5 by humans): Six workstreams (config optimization, security audit, book pipeline, paper splitting, domain classification, self-maintenance) crammed under one Goal heading. 14K chars. Done section spans all topics without separation. Agent would spend minutes parsing before acting.

Example C (rated 2.5/5 by humans): Eight goals, 13 next steps. Contains everything from outbox fixes to book pipeline to RIF experiments. Information is accurate and complete but no prioritization — an agent couldn't tell what matters most.

The pattern: single-topic or well-separated multi-topic → high score. Everything-in-one-narrative → low score, regardless of completeness.

Respond with JSON only:
{
  "score": <1-5, can use 0.5 increments>,
  "reasoning": "<2-3 sentences: what works, what's missing or confusing>"
}`;

function estimateTokens(text) {
  // Rough estimate: 1 token ≈ 4 chars for English text
  return Math.round(text.length / 4);
}

async function main() {
  const samples = JSON.parse(readFileSync(join(__dirname, 'compaction-samples.json'), 'utf8'));
  const judge = args['dry-run'] ? null : createFoldModel('sonnet');
  
  const targetSample = args.sample ? parseInt(args.sample) : null;
  const results = [];
  let totalJudgeCost = 0;

  for (let i = 0; i < samples.length; i++) {
    const sampleNum = i + 1;
    if (targetSample && sampleNum !== targetSample) continue;

    const sample = samples[i];
    const phase0 = PHASE0_RATINGS[i] || {};

    // Mechanical metrics (no API needed)
    const summaryTokensEst = estimateTokens(sample.summary);
    const compressionRatio = sample.tokensBefore / summaryTokensEst;
    
    console.log(`\n--- Sample ${sampleNum}: ${sample.sessionType} ---`);
    console.log(`  Tokens before:    ${sample.tokensBefore.toLocaleString()}`);
    console.log(`  Summary chars:    ${sample.summaryLength.toLocaleString()}`);
    console.log(`  Summary tokens:   ~${summaryTokensEst.toLocaleString()} (estimated)`);
    console.log(`  Compression:      ${compressionRatio.toFixed(1)}x`);
    console.log(`  Steph rating:     ${phase0.steph ?? 'N/A'}`);
    console.log(`  Thresh rating:    ${phase0.thresh ?? 'N/A'}`);

    let judgeResult = null;
    if (!args['dry-run']) {
      const userPrompt = `COMPACTION SUMMARY (${sample.summaryLength.toLocaleString()} chars, replacing ${sample.tokensBefore.toLocaleString()} tokens of conversation):

${sample.summary}`;

      try {
        const result = await judge({ system: JUDGE_PROMPT, user: userPrompt });
        const jsonMatch = result.text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error(`No JSON in response: ${result.text.slice(0, 200)}`);
        const parsed = JSON.parse(jsonMatch[0]);
        
        const cost = estimateCost('sonnet', result.tokensIn, result.tokensOut);
        totalJudgeCost += cost.costUsd;

        judgeResult = {
          score: parsed.score,
          reasoning: parsed.reasoning,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          latencyMs: result.latencyMs,
          costUsd: cost.costUsd,
        };

        console.log(`  Judge score:      ${parsed.score}/5`);
        console.log(`  Judge reasoning:  ${parsed.reasoning}`);
        console.log(`  Judge cost:       $${cost.costUsd.toFixed(4)} (${result.tokensIn}in/${result.tokensOut}out, ${result.latencyMs}ms)`);
      } catch (e) {
        console.log(`  Judge ERROR:      ${e.message}`);
        judgeResult = { error: e.message };
      }
    } else {
      console.log(`  Judge:            [dry-run, skipped]`);
    }

    results.push({
      sample: sampleNum,
      sessionType: sample.sessionType,
      tokensBefore: sample.tokensBefore,
      summaryChars: sample.summaryLength,
      summaryTokensEst,
      compressionRatio: Math.round(compressionRatio * 10) / 10,
      stephRating: phase0.steph,
      threshRating: phase0.thresh,
      judge: judgeResult,
    });
  }

  // Correlation analysis
  const withScores = results.filter(r => r.judge?.score != null && r.stephRating != null);
  if (withScores.length >= 3) {
    console.log(`\n=== CORRELATION ANALYSIS (n=${withScores.length}) ===`);
    
    const pairs = [
      { name: 'Judge vs Steph', a: withScores.map(r => r.judge.score), b: withScores.map(r => r.stephRating) },
      { name: 'Judge vs Thresh', a: withScores.map(r => r.judge.score), b: withScores.filter(r => r.threshRating != null).map(r => r.judge.score), b2: withScores.filter(r => r.threshRating != null).map(r => r.threshRating) },
    ];

    // Judge vs Steph
    const pearson = computePearson(withScores.map(r => r.judge.score), withScores.map(r => r.stephRating));
    const spearman = computeSpearman(withScores.map(r => r.judge.score), withScores.map(r => r.stephRating));
    console.log(`  Judge vs Steph:   Pearson=${pearson.toFixed(3)}, Spearman=${spearman.toFixed(3)}`);

    // Judge vs Thresh
    const wt = withScores.filter(r => r.threshRating != null);
    if (wt.length >= 3) {
      const p2 = computePearson(wt.map(r => r.judge.score), wt.map(r => r.threshRating));
      const s2 = computeSpearman(wt.map(r => r.judge.score), wt.map(r => r.threshRating));
      console.log(`  Judge vs Thresh:  Pearson=${p2.toFixed(3)}, Spearman=${s2.toFixed(3)}`);
    }

    // Steph vs Thresh
    const st = withScores.filter(r => r.threshRating != null);
    if (st.length >= 3) {
      const p3 = computePearson(st.map(r => r.stephRating), st.map(r => r.threshRating));
      const s3 = computeSpearman(st.map(r => r.stephRating), st.map(r => r.threshRating));
      console.log(`  Steph vs Thresh:  Pearson=${p3.toFixed(3)}, Spearman=${s3.toFixed(3)}`);
    }
  }

  // Summary stats
  const scored = results.filter(r => r.judge?.score != null);
  if (scored.length > 0) {
    const scores = scored.map(r => r.judge.score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const sd = Math.sqrt(scores.reduce((a, v) => a + (v - mean) ** 2, 0) / scores.length);
    const compressions = scored.map(r => r.compressionRatio);
    const meanComp = compressions.reduce((a, b) => a + b, 0) / compressions.length;

    console.log(`\n=== BASELINE SUMMARY ===`);
    console.log(`  Samples:          ${scored.length}`);
    console.log(`  Quality mean:     ${mean.toFixed(2)} ± ${sd.toFixed(2)}`);
    console.log(`  Quality range:    ${Math.min(...scores)} – ${Math.max(...scores)}`);
    console.log(`  Compression mean: ${meanComp.toFixed(1)}x`);
    console.log(`  Judge cost total: $${totalJudgeCost.toFixed(4)}`);
  }

  const outPath = join(__dirname, 'phase1-baseline.json');
  writeFileSync(outPath, JSON.stringify({ results, timestamp: new Date().toISOString() }, null, 2));
  console.log(`\nSaved: ${outPath}`);
}

function computePearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return (da > 0 && db > 0) ? num / Math.sqrt(da * db) : 0;
}

function computeSpearman(a, b) {
  const rank = arr => {
    const indexed = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(arr.length);
    for (let i = 0; i < indexed.length; i++) ranks[indexed[i].i] = i + 1;
    return ranks;
  };
  return computePearson(rank(a), rank(b));
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
