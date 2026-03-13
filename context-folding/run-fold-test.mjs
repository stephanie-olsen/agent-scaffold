#!/usr/bin/env node
/**
 * run-fold-test.mjs — Context folding experiment test harness.
 *
 * Usage:
 *   node run-fold-test.mjs --session <id> --strategy <s0-s7> --model <model> --mode <snapshot|replay> [options]
 *
 * Options:
 *   --session <id>       Session ID (from corpus.json)
 *   --strategy <s0-s7>   Folding strategy
 *   --model <name>       Fold model (gemini-flash, gemini-pro, sonnet, haiku, kimi)
 *   --mode <mode>        snapshot or replay
 *   --prompt <style>     conservative or aggressive (default: conservative)
 *   --snapshot <n>       For snapshot mode: threshold index 0-2 (default: 1 = 60%)
 *   --judge <model>      Judge model for ecological eval (default: haiku)
 *   --responder <model>  Responder model for ecological eval (default: sonnet)
 *   --skip-eval          Skip ecological evaluation (just measure compression)
 *   --dry-run            Parse and report, don't call APIs
 *   --fold-threshold <n> Token count to trigger folding in replay mode (default: 75000)
 *   --verbose            Extra logging
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

import { parseSession, getSnapshots, totalTokens } from './lib/parse-session.mjs';
import { getStrategy } from './lib/strategies/index.mjs';
import { createFoldModel, availableModels } from './lib/fold-model.mjs';
import { evaluateEcological } from './lib/evaluator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { values: args } = parseArgs({
  options: {
    session: { type: 'string' },
    strategy: { type: 'string' },
    model: { type: 'string' },
    mode: { type: 'string' },
    prompt: { type: 'string', default: 'conservative' },
    snapshot: { type: 'string', default: '1' },
    judge: { type: 'string', default: 'sonnet' },
    responder: { type: 'string', default: 'sonnet' },
    'skip-eval': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'fold-threshold': { type: 'string', default: '75000' },
    'max-keep-tokens': { type: 'string', default: '20000' },
    verbose: { type: 'boolean', default: false },
  },
});

async function main() {
  // Validate args
  if (!args.session || !args.strategy || !args.model || !args.mode) {
    console.error('Required: --session --strategy --model --mode');
    process.exit(1);
  }

  const corpusRaw = JSON.parse(readFileSync(join(__dirname, 'corpus.json'), 'utf-8'));
  const corpus = Array.isArray(corpusRaw) ? corpusRaw : corpusRaw.sessions;
  const sessionInfo = corpus.find(s => s.id === args.session || s.id.startsWith(args.session));
  if (!sessionInfo) {
    console.error(`Session not found: ${args.session}. Available: ${corpus.map(s => s.id.slice(0, 8)).join(', ')}`);
    process.exit(1);
  }
  // Resolve path
  const sessionsDir = '/home/thresh/.openclaw/agents/main/sessions';
  if (!sessionInfo.path) sessionInfo.path = join(sessionsDir, `${sessionInfo.id}.jsonl`);

  console.log(`\n=== Context Folding Test ===`);
  console.log(`Session: ${sessionInfo.id.slice(0, 8)} (${sessionInfo.type})`);
  console.log(`Strategy: ${args.strategy} | Model: ${args.model} | Mode: ${args.mode} | Prompt: ${args.prompt}`);

  // Parse session
  const { messages, metadata } = parseSession(sessionInfo.path);
  console.log(`Parsed: ${messages.length} messages, ${totalTokens(messages)} estimated tokens`);

  const strategy = getStrategy(args.strategy);
  const foldModel = args['dry-run'] ? dryRunModel() : createFoldModel(args.model);
  const foldThreshold = parseInt(args['fold-threshold']);

  let result;
  if (args.mode === 'snapshot') {
    result = await runSnapshot({ messages, strategy, foldModel, sessionInfo });
  } else if (args.mode === 'replay') {
    result = await runReplay({ messages, strategy, foldModel, sessionInfo, foldThreshold });
  } else {
    console.error(`Unknown mode: ${args.mode}`);
    process.exit(1);
  }

  // Save result
  const resultsDir = join(__dirname, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const snapSuffix = args.mode === 'snapshot' ? `-t${args.snapshot}` : '';
  const filename = `${sessionInfo.id.slice(0, 8)}-${args.strategy}-${args.model}-${args.mode}${snapSuffix}-${args.prompt}.json`;
  writeFileSync(join(resultsDir, filename), JSON.stringify(result, null, 2));
  console.log(`\nSaved: results/${filename}`);
}

async function runSnapshot({ messages, strategy, foldModel, sessionInfo }) {
  const snapshotIdx = parseInt(args.snapshot);
  const snapshots = getSnapshots(messages, [0.5, 0.6, 0.7]);

  if (snapshotIdx >= snapshots.length) {
    console.log(`Snapshot ${snapshotIdx} not available (only ${snapshots.length} snapshots). Session too short — skipping.`);
    return { session: sessionInfo.id, strategy: args.strategy, model: args.model, mode: 'snapshot', skipped: true, reason: 'session too short for snapshot threshold' };
  }

  const snap = snapshots[snapshotIdx];
  console.log(`Snapshot: ${snap.threshold * 100}% = ${snap.messageCount} messages, ${snap.tokenCount} tokens`);

  const start = Date.now();
  const foldResult = await strategy(snap.messages, {
    foldModel,
    promptStyle: args.prompt,
    keepRecent: 999, // effectively unlimited — maxKeepTokens is the real constraint
    maxKeepTokens: parseInt(args['max-keep-tokens']),
  });
  const foldLatencyMs = Date.now() - start;

  const foldedTokens = totalTokens(foldResult.folded);
  const compressionRatio = snap.tokenCount / Math.max(foldedTokens, 1);

  console.log(`Folded: ${snap.tokenCount} → ${foldedTokens} tokens (${compressionRatio.toFixed(2)}x) in ${foldLatencyMs}ms`);

  // Ecological evaluation
  let evaluation = null;
  if (!args['skip-eval'] && !args['dry-run']) {
    const nextUserIdx = snap.messages.length;
    const nextUser = messages.slice(nextUserIdx).find(m => m.role === 'user');
    const nextAssistant = nextUser ? messages.slice(messages.indexOf(nextUser) + 1).find(m => m.role === 'assistant') : null;

    // Check both parsed content and raw content (tool calls may be in raw only)
    const effectiveContent = (nextAssistant?.content?.length > 0) ? nextAssistant.content :
      (Array.isArray(nextAssistant?.raw?.content) && nextAssistant.raw.content.length > 0) ? nextAssistant.raw.content : null;
    const hasContent = effectiveContent !== null;
    if (nextUser && nextAssistant && hasContent) {
      console.log(`Evaluating response quality...`);
      evaluation = await evaluateEcological({
        foldedMessages: foldResult.folded,
        nextUserMessage: nextUser,
        originalResponse: effectiveContent,
        responderModel: args.responder,
        judgeModel: args.judge,
      });
      console.log(`Ecological retention: ${evaluation.scores.mean?.toFixed(3) ?? 'N/A'}`);
    } else {
      const reason = !nextUser ? 'no user message after snapshot' : !nextAssistant ? 'no assistant response' : 'empty assistant response';
      console.log(`Skipping eval: ${reason}`);
      evaluation = { scores: null, skipped: true, reason };
    }
  }

  return {
    session: sessionInfo.id,
    sessionType: sessionInfo.type,
    strategy: args.strategy,
    model: args.model,
    mode: 'snapshot',
    promptStyle: args.prompt,
    snapshot: {
      threshold: snap.threshold,
      originalTokens: snap.tokenCount,
      foldedTokens,
      compressionRatio,
      foldLatencyMs,
      foldTokensIn: foldResult.foldTokensIn,
      foldTokensOut: foldResult.foldTokensOut,
      plan: foldResult.plan,
    },
    evaluation,
    timestamp: new Date().toISOString(),
  };
}

async function runReplay({ messages, strategy, foldModel, sessionInfo, foldThreshold }) {
  console.log(`Replay mode: fold threshold = ${foldThreshold} tokens`);

  const context = []; // Current context window
  const foldPoints = [];
  let previousTiers = null; // For S7 state carry-forward
  let totalFoldCost = 0;

  for (let i = 0; i < messages.length; i++) {
    context.push({ ...messages[i], index: context.length });

    const currentTokens = totalTokens(context);

    // Check if we need to fold
    if (currentTokens >= foldThreshold) {
      console.log(`  Fold at msg ${i}: ${currentTokens} tokens (${context.length} messages)`);

      const start = Date.now();
      const foldResult = await strategy(context, {
        foldModel,
        promptStyle: args.prompt,
        keepRecent: 999, // effectively unlimited — maxKeepTokens is the real constraint
        maxKeepTokens: parseInt(args['max-keep-tokens']),
        previousTiers, // S7 support
      });
      const foldLatencyMs = Date.now() - start;

      const foldedTokens = totalTokens(foldResult.folded);
      const compressionRatio = currentTokens / Math.max(foldedTokens, 1);

      // Ecological evaluation at this fold point
      let evaluation = null;
      if (!args['skip-eval'] && !args['dry-run']) {
        const nextUser = messages.slice(i + 1).find(m => m.role === 'user');
        const nextAssistant = nextUser ? messages.slice(messages.indexOf(nextUser) + 1).find(m => m.role === 'assistant') : null;

        if (nextUser && nextAssistant) {
          evaluation = await evaluateEcological({
            foldedMessages: foldResult.folded,
            nextUserMessage: nextUser,
            originalResponse: nextAssistant.content,
            responderModel: args.responder,
            judgeModel: args.judge,
          });
          console.log(`    Retention: ${evaluation.scores.mean?.toFixed(3) ?? 'N/A'} | ${currentTokens}→${foldedTokens} (${compressionRatio.toFixed(2)}x) ${foldLatencyMs}ms`);
        }
      } else {
        console.log(`    ${currentTokens}→${foldedTokens} (${compressionRatio.toFixed(2)}x) ${foldLatencyMs}ms`);
      }

      foldPoints.push({
        turn: i,
        originalTokens: currentTokens,
        foldedTokens,
        compressionRatio,
        foldLatencyMs,
        foldTokensIn: foldResult.foldTokensIn,
        foldTokensOut: foldResult.foldTokensOut,
        plan: foldResult.plan,
        ecologicalRetention: evaluation?.scores || null,
      });

      // Replace context with folded version
      context.length = 0;
      context.push(...foldResult.folded);
      previousTiers = foldResult.tiers || previousTiers;

      // Estimate cost (rough)
      totalFoldCost += (foldResult.foldTokensIn * 0.00001 + foldResult.foldTokensOut * 0.00003); // ~flash pricing
    }
  }

  // Compute aggregate metrics
  const retentionScores = foldPoints.map(fp => fp.ecologicalRetention?.mean).filter(s => typeof s === 'number');
  const meanRetention = retentionScores.length > 0 ? retentionScores.reduce((a, b) => a + b, 0) / retentionScores.length : null;

  // Degradation rate: slope of retention over fold points
  let degradationRate = null;
  if (retentionScores.length >= 2) {
    const n = retentionScores.length;
    const xMean = (n - 1) / 2;
    const yMean = meanRetention;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - xMean) * (retentionScores[i] - yMean);
      den += (i - xMean) ** 2;
    }
    degradationRate = den > 0 ? num / den : 0;
  }

  const lastFold = foldPoints[foldPoints.length - 1];

  return {
    session: sessionInfo.id,
    sessionType: sessionInfo.type,
    strategy: args.strategy,
    model: args.model,
    mode: 'replay',
    promptStyle: args.prompt,
    foldPoints,
    steadyStateTokens: lastFold?.foldedTokens || totalTokens(context),
    meanRetention,
    degradationRate,
    totalFoldCost,
    totalFolds: foldPoints.length,
    errors: [],
    timestamp: new Date().toISOString(),
  };
}

function dryRunModel() {
  return async ({ system, user }) => ({
    text: '[dry-run] Would call LLM with ' + system.length + ' system chars + ' + user.length + ' user chars',
    tokensIn: Math.ceil((system.length + user.length) / 4),
    tokensOut: 100,
    latencyMs: 0,
  });
}

main().catch(e => {
  console.error('Error:', e.message);
  if (args.verbose) console.error(e.stack);
  process.exit(1);
});
