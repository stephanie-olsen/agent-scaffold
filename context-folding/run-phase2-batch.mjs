#!/usr/bin/env node
/**
 * Phase 2: Batch fold + judge runner.
 * 
 * Runs a slice of the experiment matrix:
 *   strategies × retained_sizes × thresholds × corpus_sessions
 * 
 * For each combination:
 *   1. Parse session transcript up to threshold
 *   2. Apply folding strategy with given retained token budget
 *   3. Judge the resulting summary with single-score evaluator
 *   4. Record all metrics (quality, compression, latency, cost)
 * 
 * Usage:
 *   node run-phase2-batch.mjs --strategies s3,s5,s9 --retained 10000,20000,30000 --thresholds 65000,80000,100000 [--sessions all] [--reps 3] [--dry-run]
 *   node run-phase2-batch.mjs --slice 1/3   # run 1st third of the matrix
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { parseSession, getSnapshots, totalTokens } from './lib/parse-session.mjs';
import { getStrategy } from './lib/strategies/index.mjs';
import { createFoldModel, estimateCost } from './lib/fold-model.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { values: args } = parseArgs({
  options: {
    'strategies': { type: 'string', default: 's3,s5,s9' },
    'retained': { type: 'string', default: '10000,20000,30000' },
    'thresholds': { type: 'string', default: '65000,80000,100000' },
    'sessions': { type: 'string', default: 'all' },
    'reps': { type: 'string', default: '3' },
    'slice': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'verbose': { type: 'boolean', default: false },
    'fold-model': { type: 'string', default: 'sonnet' },
    'judge-model': { type: 'string', default: 'sonnet' },
  },
  strict: false,
});

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

const sessionsDir = join(dirname(__dirname), '.openclaw', 'agents', 'main', 'sessions');

async function judgeSummary(judge, summary, tokensBefore) {
  const result = await judge({
    system: JUDGE_PROMPT,
    user: `COMPACTION SUMMARY (${summary.length.toLocaleString()} chars, replacing ${tokensBefore.toLocaleString()} tokens of conversation):\n\n${summary}`,
  });
  
  const jsonMatch = result.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in judge response: ${result.text.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]);
  
  return {
    score: parsed.score,
    reasoning: parsed.reasoning,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    latencyMs: result.latencyMs,
  };
}

async function main() {
  const corpus = JSON.parse(readFileSync(join(__dirname, 'corpus.json'), 'utf-8'));
  const sessions = corpus.sessions || corpus;
  
  const strategyNames = args.strategies.split(',');
  const retainedSizes = args.retained.split(',').map(Number);
  const thresholds = args.thresholds.split(',').map(Number);
  const reps = parseInt(args.reps);
  const sessionFilter = args.sessions === 'all' ? null : args.sessions.split(',');
  
  // Build the full matrix
  let matrix = [];
  for (const session of sessions) {
    if (sessionFilter && !sessionFilter.some(f => session.id.startsWith(f))) continue;
    for (const strat of strategyNames) {
      for (const retained of retainedSizes) {
        for (const threshold of thresholds) {
          for (let rep = 1; rep <= reps; rep++) {
            matrix.push({ session, strat, retained, threshold, rep });
          }
        }
      }
    }
  }
  
  // Slice support for parallel execution
  if (args.slice) {
    const [sliceNum, sliceTotal] = args.slice.split('/').map(Number);
    const chunkSize = Math.ceil(matrix.length / sliceTotal);
    const start = (sliceNum - 1) * chunkSize;
    matrix = matrix.slice(start, start + chunkSize);
  }
  
  console.log(`Phase 2 batch: ${matrix.length} runs`);
  console.log(`  Strategies: ${strategyNames.join(', ')}`);
  console.log(`  Retained: ${retainedSizes.join(', ')}`);
  console.log(`  Thresholds: ${thresholds.join(', ')}`);
  console.log(`  Sessions: ${sessionFilter || 'all'} (${sessions.length})`);
  console.log(`  Reps: ${reps}`);
  console.log(`  Fold model: ${args['fold-model']}, Judge: ${args['judge-model']}`);
  if (args['dry-run']) console.log(`  [DRY RUN]`);
  
  const resultsDir = join(__dirname, 'results', 'phase2');
  mkdirSync(resultsDir, { recursive: true });
  
  const foldModel = args['dry-run'] ? null : createFoldModel(args['fold-model']);
  const judgeModel = args['dry-run'] ? null : createFoldModel(args['judge-model']);
  
  const results = [];
  let totalCost = 0;
  let completed = 0;
  
  for (const run of matrix) {
    const { session, strat, retained, threshold, rep } = run;
    const foldModelTag = args['fold-model'] === 'sonnet' ? '' : `-${args['fold-model']}`;
    const runId = `${session.id.slice(0, 8)}-${strat}-${retained / 1000}k-${threshold / 1000}k${foldModelTag}-r${rep}`;
    
    // Skip if result already exists (resume support)
    const resultPath = join(resultsDir, `${runId}.json`);
    if (existsSync(resultPath)) {
      try {
        const existing = JSON.parse(readFileSync(resultPath, 'utf-8'));
        results.push(existing);
        completed++;
        console.log(`[${completed}/${matrix.length}] ${runId} — CACHED (score=${existing.judgeScore})`);
        continue;
      } catch {}
    }
    
    console.log(`\n[${completed + 1}/${matrix.length}] ${runId}`);
    
    try {
      // Parse session
      const sessionPath = join('/home/thresh/.openclaw/agents/main/sessions', `${session.id}.jsonl`);
      if (!existsSync(sessionPath)) {
        console.log(`  SKIP: session file not found`);
        continue;
      }
      
      const { messages } = parseSession(sessionPath);
      
      // Find the snapshot point (where tokens exceed threshold)
      let tokenCount = 0;
      let snapshotIdx = messages.length;
      for (let i = 0; i < messages.length; i++) {
        const msgTokens = messages[i].tokens || Math.round((messages[i].content?.length || 0) / 4);
        tokenCount += msgTokens;
        if (tokenCount >= threshold) {
          snapshotIdx = i;
          break;
        }
      }
      
      if (snapshotIdx >= messages.length) {
        console.log(`  SKIP: session doesn't reach threshold ${threshold} (only ${tokenCount} tokens)`);
        continue;
      }
      
      // Split into fold target and kept tail
      // The "tail" is the last N tokens of messages before snapshot
      const msgsToFold = messages.slice(0, snapshotIdx);
      
      // Calculate kept tail from end of fold target
      let tailTokens = 0;
      let tailStart = msgsToFold.length;
      for (let i = msgsToFold.length - 1; i >= 0; i--) {
        const t = msgsToFold[i].tokens || Math.round((msgsToFold[i].content?.length || 0) / 4);
        if (tailTokens + t > retained) break;
        tailTokens += t;
        tailStart = i;
      }
      
      const foldTarget = msgsToFold.slice(0, tailStart);
      const keptTail = msgsToFold.slice(tailStart);
      
      if (foldTarget.length === 0) {
        console.log(`  SKIP: nothing to fold after keeping ${retained} tail tokens`);
        continue;
      }
      
      const foldInputTokens = foldTarget.reduce((s, m) => s + (m.tokens || Math.round((m.content?.length || 0) / 4)), 0);
      
      console.log(`  Fold target: ${foldTarget.length} msgs (${foldInputTokens} tokens), Tail: ${keptTail.length} msgs (${tailTokens} tokens)`);
      
      if (args['dry-run']) {
        completed++;
        results.push({ runId, status: 'dry-run', session: session.id.slice(0, 8), strategy: strat, retained, threshold, rep, foldInputTokens, tailTokens });
        continue;
      }
      
      // Run the fold strategy — strategies expect fold(messages, opts)
      const strategy = getStrategy(strat);
      const foldStart = Date.now();
      const foldResult = await strategy(foldTarget, {
        foldModel,
        maxKeepTokens: retained,
        keepRecent: 999, // not used when maxKeepTokens is set
        threshold,
      });
      const foldLatencyMs = Date.now() - foldStart;
      
      // Extract summary text from folded messages
      const summaryMsgs = (foldResult.folded || []).filter(m => m.role === 'compactionSummary');
      const summaryText = summaryMsgs.map(m => m.content || m.raw?.summary || '').join('\n\n');
      const summaryTokensEst = Math.round(summaryText.length / 4);
      
      // Compression ratio: input / (summary + tail)
      const totalOutputTokens = summaryTokensEst + tailTokens;
      const compressionRatio = tokenCount / totalOutputTokens;
      
      // Fold cost
      const foldTokensIn = foldResult.foldTokensIn || foldInputTokens;
      const foldTokensOut = foldResult.foldTokensOut || summaryTokensEst;
      const foldCost = estimateCost(args['fold-model'], foldTokensIn, foldTokensOut);
      
      console.log(`  Fold: ${summaryText.length} chars (~${summaryTokensEst} tokens), ${compressionRatio.toFixed(1)}x compression, ${foldLatencyMs}ms`);
      
      // Judge the summary
      const judgeResult = await judgeSummary(judgeModel, summaryText, tokenCount);
      const judgeCost = estimateCost(args['judge-model'], judgeResult.tokensIn, judgeResult.tokensOut);
      
      const runCost = foldCost.costUsd + judgeCost.costUsd;
      totalCost += runCost;
      
      console.log(`  Judge: ${judgeResult.score}/5 — ${judgeResult.reasoning.slice(0, 100)}`);
      console.log(`  Cost: $${runCost.toFixed(4)} (fold $${foldCost.costUsd.toFixed(4)} + judge $${judgeCost.costUsd.toFixed(4)})`);
      
      const result = {
        runId,
        session: session.id.slice(0, 8),
        sessionType: session.type,
        strategy: strat,
        retained,
        threshold,
        rep,
        foldInputTokens,
        tailTokens,
        summaryChars: summaryText.length,
        summaryTokensEst,
        compressionRatio: Math.round(compressionRatio * 10) / 10,
        foldLatencyMs,
        foldTokensIn,
        foldTokensOut,
        foldCostUsd: foldCost.costUsd,
        judgeScore: judgeResult.score,
        judgeReasoning: judgeResult.reasoning,
        judgeCostUsd: judgeCost.costUsd,
        totalCostUsd: runCost,
        timestamp: new Date().toISOString(),
      };
      
      // Save individual result (for resume support)
      writeFileSync(resultPath, JSON.stringify(result, null, 2));
      results.push(result);
      completed++;
      
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
      results.push({ runId, status: 'error', error: e.message, session: session.id.slice(0, 8), strategy: strat, retained, threshold, rep });
      completed++;
    }
  }
  
  // Summary
  const valid = results.filter(r => r.judgeScore != null);
  if (valid.length > 0) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`BATCH COMPLETE: ${valid.length} scored, ${results.length - valid.length} skipped/errored`);
    console.log(`Total cost: $${totalCost.toFixed(4)}`);
    
    // Per-strategy summary
    const byStrat = {};
    for (const r of valid) {
      if (!byStrat[r.strategy]) byStrat[r.strategy] = [];
      byStrat[r.strategy].push(r);
    }
    
    console.log(`\nStrategy    N  Quality  Compress  Latency     Cost`);
    console.log('-'.repeat(54));
    for (const [s, runs] of Object.entries(byStrat).sort()) {
      const avgScore = runs.reduce((a, r) => a + r.judgeScore, 0) / runs.length;
      const avgComp = runs.reduce((a, r) => a + r.compressionRatio, 0) / runs.length;
      const avgLat = runs.reduce((a, r) => a + r.foldLatencyMs, 0) / runs.length;
      const avgCost = runs.reduce((a, r) => a + r.totalCostUsd, 0) / runs.length;
      console.log(`${s.padEnd(10)} ${String(runs.length).padStart(3)}  ${avgScore.toFixed(2).padStart(7)}  ${(avgComp.toFixed(1) + 'x').padStart(8)}  ${((avgLat/1000).toFixed(1) + 's').padStart(7)}  $${avgCost.toFixed(4)}`);
    }
  }
  
  // Save batch summary
  const batchPath = join(resultsDir, `batch-summary-${Date.now()}.json`);
  writeFileSync(batchPath, JSON.stringify({ results, totalCost, timestamp: new Date().toISOString() }, null, 2));
  console.log(`\nBatch saved: ${batchPath}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
