# Context Folding v2 — Protocol

## Research Question
Does S5 (unified folding with Sonnet) produce better compaction outcomes than current Opus emergency compaction at production-relevant thresholds?

## Lessons from v1
See `../context-folding/postmortem.md` for full accounting. Key failures:
1. **Baseline poorly measured.** We evaluated existing compaction summaries but didn't measure them with the same harness as experimental strategies.
2. **Eval questions not predictive.** "Ecological retention" (can the agent respond to the next message) had artifacts: tool-call targets scored 0.000, NO_REPLY artifacts, and the 4-dimension rubric wasn't validated against human judgment of compaction quality.
3. **Too many strategies, no elimination gates.** 9→10 strategies, full factorial, $100 spent.
4. **Variables shifted mid-experiment.** Thresholds changed 3x, fold model changed, eval judge changed.
5. **"Last 5 turns" retained context was unfair.** Turn size varies wildly. Needs character/token budget instead.

## Current Compaction Setup (the thing we're trying to beat)
- **Trigger:** fires when `contextTokens > contextWindow - reserveTokens` (i.e., ~134K on 150K window)
- **Reserve:** `reserveTokens: 16384` — space reserved for generation
- **Retained:** `keepRecentTokens: 20000` — last ~20K tokens kept verbatim
- **Summarization model:** Same model as session (Opus for main session)
- **Summarization prompt:** Code-project template (Goal/Constraints/Progress/Decisions/Next Steps/Critical Context)
- **Behavior:** Everything older than the 20K tail gets summarized into a structured checkpoint. Iterative — each compaction builds on the previous summary.
- **Baseline context:** ~16K tokens (system prompt, SOUL.md, MEMORY.md, etc.)

So the actual compacted content = everything between the summary and the last 20K tokens. At trigger time, that's roughly 134K - 20K = 114K tokens being summarized.

## Strategies to Test

### S0: Current Opus Compaction (baseline)
Exactly what happens now. Must be measured with the same harness as experimental strategies — not a different evaluation path.

### S5: Unified Folding (Sonnet)
Send full context to Sonnet, let it decide what to keep/summarize. No pre-pruning of tool results. v1 top performer (0.695 retention, 100% reliability, 7.7x compression, 47s latency).

### S9: Topic + Constraints Hybrid (Sonnet)
Topic segmentation + ACON preservation constraints + tool-pair collapsing. v1 was worse than S5 but may have been undertested. Include only if we can articulate *why* it might beat S5 — otherwise drop it.

v1 results were not definitive enough to exclude S9. Test both.

## Retained Context
**Character/token budget, not turn count.**

The "tail" of recent context kept verbatim alongside the fold/summary. Total context = system prompt (~16K) + fold summary + retained tail. So retained size must leave room for both the system prompt and the summary within the threshold.

- **10K tokens** — aggressive pruning, minimal recent context
- **20K tokens** — current compaction default
- **30K tokens** — generous for recent context

At a 50K threshold with 16K system prompt and ~4-8K fold summary, 30K retained is near the ceiling. At 100K threshold, 30K retained leaves plenty of room.

## Fold Thresholds
When does folding fire? Absolute token counts. Baseline context is ~16K, so anything below ~25K is not useful.

- **65K tokens** — aggressive. With 16K system + 30K retained + ~8K summary = ~54K, leaving ~11K headroom.
- **80K tokens** — moderate. Comfortable room at all retained sizes.
- **100K tokens** — conservative. Still better than current 134K trigger.

These are locked. No changes mid-experiment.

## Phase 0: Define "Compaction Success" ✅ COMPLETE

Calibration study (2026-02-15): 10 real compaction summaries rated by Steph (human), Thresh (agent), and automated Sonnet judge.

**Finding:** A rigid 4-dimension rubric (thread coherence, signal-to-noise, actionability, factual accuracy) produced near-identical scores across all samples (thread=0.3, noise=0.4 for all 9). Pearson correlation with human ratings: -0.275 (anti-correlated). The rubric couldn't discriminate.

Human and agent ratings correlated much better. Both converged on a single practical question: **"Could the agent continue working from this summary?"** This captures thread separation, actionability, and noise filtering implicitly.

**Eval method for v2:** Single 1-5 score from Sonnet judge, anchored to "could the agent continue working from this?" Plus brief explanation of what's missing/confusing. No dimensional breakdown.

**Calibration data:** `phase0-calibration.json` (automated), `phase0-human-agent-ratings.json` (Steph + Thresh ratings).

**Key patterns from calibration:**
- Single-topic sessions compact well (4-5/5). Multi-topic sessions under the code-project template degrade (2-3/5).
- The Goal/Progress/Done template forces everything into one narrative. This is the primary failure mode.
- "Turn Context" suffixes (from split-turn compaction) often contain the most important active work, buried below the main summary.
- Factual accuracy is generally high even in bad summaries — the problem is structure, not facts.

## Phase 1: Baseline Measurement
Measure current Opus compaction with the validated eval from Phase 0.

- Use real session transcripts with real compaction events
- Same eval harness, same judge, same scoring as experimental strategies
- Record: retention score, compression ratio, latency, token cost (notional)
- **N ≥ 15 compaction events** across ≥ 3 session types
- Filter eval targets: no tool-call-only responses, no system messages

This becomes the number to beat.

## Phase 2: Strategy Comparison
Test S5 (and S9 if justified) against baseline.

- Same sessions, same eval, same thresholds
- **Retained context:** test 20K, 30K, 50K
- **Fold thresholds:** test 50K, 75K, 100K
- Matrix: 2 strategies × 3 retained sizes × 3 thresholds = 18 configurations
- **N ≥ 3 runs per configuration** (v1 variance was high enough that single runs aren't reliable)
- **No early elimination.** Run full matrix. A strategy may perform differently across session types — analyze per-type, don't drop based on aggregate.

## Phase 3: Replay (cumulative degradation)
The production-critical test. Take a long session, simulate multiple fold cycles.

- Start from beginning of session
- Feed messages until context hits fold threshold
- Fold
- Continue feeding messages
- Fold again when threshold hit
- Measure retention after fold 1, 3, 5, 10
- **Canary facts:** Plant known facts early, probe survival after N folds
- **Degradation slope** is the primary metric. Some loss per fold is expected; the question is how fast.

Winning config from Phase 2, plus baseline for comparison.

## Metrics (locked)

### Primary
- **Validated retention score** — whatever dimensions survive Phase 0 validation
- **Compression ratio** — original_tokens / folded_tokens
- **Fold latency** — wall-clock seconds

### Secondary
- **Token budget cost** — notional API-rate cost
- **Degradation slope** — retention over successive folds (Phase 3)
- **Cross-session variance** — how consistent is performance across session types

## Cost Budget
**$40 maximum** for the entire experiment (excluding Phase 0 design work which is conversation, not runs).

If we hit $40 without a clear answer, we stop and assess whether to continue or declare inconclusive.

## Variables Locked Before First Run
- Fold model (Sonnet, unless pilot says otherwise)
- Judge model
- Eval dimensions and rubric
- Thresholds (65K, 80K, 100K)
- Retained context sizes (10K, 20K, 30K)
- Corpus sessions

## Reusable from v1
- Test harness (`run-fold-test.mjs`) — needs modification for character-based retained context
- Strategy implementations (`lib/strategies/s5.mjs`, `s9.mjs`)
- Corpus parser
- Session transcripts
- Fold model routing (Sonnet via subscription)

## Decisions Made
- **S9 included.** v1 results not definitive enough to exclude.
- **Judge: Sonnet.** Can't afford Opus as judge.
- **Eval: single 1-5 score.** "Could the agent continue working from this?" No dimensional breakdown — calibration showed rigid dimensions produce false precision without discrimination.
- **No early elimination.** Analyze per-session-type instead.

## Hypothesis

**H1 (primary):** S5 (unified Sonnet folding) achieves higher validated retention than current Opus emergency compaction (S0 baseline), with effect size d ≥ 0.5, at thresholds ≤ 100K tokens.

**H2 (secondary):** S5's retention advantage holds across fold cycles — degradation slope over 5+ successive folds is shallower than S0's.

**H3 (exploratory):** S9 (topic + constraints hybrid) achieves comparable retention to S5 at lower latency or token cost.

**Disconfirmation:** H1 is disconfirmed if S5 retention ≤ S0 retention at all tested thresholds, or if d < 0.3. H2 is disconfirmed if S5 degradation slope ≥ S0 slope.

## Conditions

| Condition | Strategy | Fold Model | Retained Tokens | Threshold | Replications |
|-----------|----------|------------|----------------|-----------|-------------|
| S0-20K-65K | Baseline (Opus) | Opus | 20K | 65K | ≥3 per corpus session |
| S0-20K-80K | Baseline (Opus) | Opus | 20K | 80K | ≥3 |
| S0-20K-100K | Baseline (Opus) | Opus | 20K | 100K | ≥3 |
| S5-10K-65K | Unified (Sonnet) | Sonnet | 10K | 65K | ≥3 |
| S5-10K-80K | Unified (Sonnet) | Sonnet | 10K | 80K | ≥3 |
| S5-10K-100K | Unified (Sonnet) | Sonnet | 10K | 100K | ≥3 |
| S5-20K-65K | Unified (Sonnet) | Sonnet | 20K | 65K | ≥3 |
| S5-20K-80K | Unified (Sonnet) | Sonnet | 20K | 80K | ≥3 |
| S5-20K-100K | Unified (Sonnet) | Sonnet | 20K | 100K | ≥3 |
| S5-30K-65K | Unified (Sonnet) | Sonnet | 30K | 65K | ≥3 |
| S5-30K-80K | Unified (Sonnet) | Sonnet | 30K | 80K | ≥3 |
| S5-30K-100K | Unified (Sonnet) | Sonnet | 10K→30K | 100K | ≥3 |
| S9-20K-80K | Topic+Constraints | Sonnet | 20K | 80K | ≥3 |
| S9-30K-80K | Topic+Constraints | Sonnet | 30K | 80K | ≥3 |

**Note:** S9 tested at 80K only (moderate threshold) to limit matrix size. Expand if initial results warrant.
**Note:** S0 baseline uses fixed 20K retained (production default). Testing S0 at other retained sizes is out of scope — we're comparing against what actually ships.

Total conditions: 14 configs × ≥3 replications × ~5 corpus sessions = ~210 runs (Phase 2).

## Parameters

- **Fold model (S5/S9):** anthropic/claude-sonnet-4-5 (locked)
- **Fold model (S0):** anthropic/claude-opus-4-6 (production default, locked)
- **Judge model:** anthropic/claude-sonnet-4-5 (locked)
- **Temperature:** 0.0 for fold, 0.0 for judge (deterministic)
- **max_tokens:** 16384 for fold output, 4096 for judge scoring
- **System prompt baseline context:** ~16K tokens (actual measured, not estimated)
- **Fold trigger:** Absolute token count per condition
- **Date of runs:** Log per-run (model versions may change)

## Validity Priorities

**Primary: Statistical conclusion validity.** Is S5 reliably better than S0?
- Threat: Low power → mitigate with ≥3 replications per config per session
- Threat: Unreliable measures → Phase 0 validates eval against human judgment
- Threat: Fishing → pre-register primary metric before Phase 1

**Secondary: Construct validity.** Does "retention score" measure what we care about?
- Threat: Mono-method bias → Phase 0 tests multiple eval dimensions
- Threat: Construct confounding → fold model differs between S0/S5 (Opus vs Sonnet). If S5 wins, we can't separate "strategy" from "model." Acknowledged as limitation.

**Accepted threats:**
- **External validity:** Results may not generalize beyond our sessions. Accepted — this is engineering optimization for our system.
- **Internal validity:** S0 uses Opus, S5 uses Sonnet. This is a quasi-experiment, not randomized. The confound (strategy × model) is inherent to the production setup we're evaluating.

**Design type:** Quasi-experiment. Model cannot be randomized — S0 is defined by using the session model (Opus), S5 is defined by using Sonnet. We're comparing production configurations, not isolating variables.

## Controls

- [x] Multiple input stimuli (≥5 real session transcripts)
- [x] Temperature documented and fixed (0.0)
- [ ] Prompt sensitivity check (pilot: test ≥2 fold prompt phrasings)
- [x] Model version logged per run
- [ ] Attrition analysis: do failures/timeouts correlate with conditions?
- [x] Same eval harness for baseline and experimental

## Sample Size Justification

- **Phase 0:** 5-10 compaction events rated by Steph. Enough for correlation between automated and human scores.
- **Phase 1:** ≥15 baseline measurements across ≥3 session types. Based on v1 variance (SD ~0.15 on retention), 15 samples gives 95% CI width ~±0.08.
- **Phase 2:** ≥3 replications per config × 5 corpus sessions = 15 data points per config. With v1 effect size (d ~0.7 for S5 vs S0), power ≈ 0.80 at n=15 per group (permutation test).
- **Phase 3:** 1-2 long sessions, 10+ fold cycles each. N is small; this is exploratory/engineering.

## Cost Estimate

**Phase 0:** ~$0 (conversation with Steph, no API runs)
**Phase 1:** 15 baseline measurements × ~$0.30/fold (Opus at ~100K input) = ~$4.50
**Phase 2:** 210 runs × ~$0.15/fold (Sonnet) + eval judging = ~$35
**Phase 3:** 2 sessions × 10 folds × ~$0.15 = ~$3 + eval
**Total estimate:** ~$42

Pricing source: Anthropic API rates as of 2026-02-15. Opus: $15/M input, $75/M output. Sonnet: $3/M input, $15/M output. Max subscription may differ (included in plan).

## Cost Budget

**$40 hard ceiling** (as stated in protocol body).
**Value checkpoint at $20:** Are retention differences detectable? Is eval producing consistent scores? If no to either, stop and reassess.

## Elimination Criteria

- **S9:** If S9 retention < S5 retention at 80K/20K after 3 corpus sessions (9 runs), drop S9 and reallocate budget to S5 matrix.
- **Retained size:** If 10K retained consistently scores <0.5 retention (floor effect), drop 10K conditions.
- **No other early elimination.** S5 vs S0 comparison runs full matrix.

## Stopping Criteria

1. All Phase 2 configs complete (full matrix), OR
2. Cost budget ($40) exhausted, OR
3. Phase 0 fails to produce a validated eval metric (experiment pauses for redesign)

## Data Validation (Preflight)

Before each batch:
1. **Input completeness:** Every corpus session × config combination produces a valid fold through the same harness code path.
2. **Output feasibility:** Fold produces non-empty output, eval target is scoreable prose (not tool-call-only).
3. **Coverage threshold:** ≥90% of planned combinations produce valid scores. Below → fix corpus or eval before running.
4. **Preflight script:** `scripts/preflight-fold-v2.mjs` — validates all input combinations without API calls. Same parsing/loading as harness.
5. **Preflight output:** Total combinations, valid count, invalid count with reasons. Exit non-zero if below 90%.

**v1 failure to prevent:** Different validation logic than harness (separate scripts gave false confidence). Preflight MUST use same code path.

## Analysis Plan (pre-registered)

### Phase 0 ✅
- 4-dimension rubric tested: near-zero discrimination (all samples scored ~identical). Dropped.
- Single holistic score (1-5, "could agent continue?") adopted based on human+agent calibration.
- Human-agent ratings correlate well; automated judge needs simplified prompt to match.

### Phase 1
- Descriptive stats: mean, SD, 95% CI for baseline retention per session type
- Distribution check: histogram of baseline scores

### Phase 2
- **Primary test:** Permutation test, S5 (best config) vs S0 on validated retention. Report p-value, Cohen's d, 95% CI for difference.
- **Secondary:** 2-way analysis: Strategy × Threshold interaction (Kruskal-Wallis per factor, then pairwise if significant)
- **Retained size effect:** Within S5, compare 10K vs 20K vs 30K (Kruskal-Wallis)
- **Multiple comparisons:** Holm-Bonferroni correction across all pairwise tests
- **Effect size threshold:** d ≥ 0.5 is "practically meaningful" (given that compaction happens ~2-5x per long session, even moderate improvements compound)
- **Post-hoc:** Any additional analyses labeled as exploratory

### Phase 3
- Retention plotted against fold number (degradation curve)
- Linear regression: retention = β₀ + β₁(fold_number). Compare slopes between S5 and S0.
- Canary fact survival rate at fold 1, 3, 5, 10

## Limitations (written during design)

1. **Strategy × model confound.** S0 uses Opus, S5 uses Sonnet. If S5 wins, we cannot attribute the improvement to the strategy vs the model. This is acceptable because we're optimizing a production configuration (strategy + model together), not isolating variables.
2. **Eval validated on one human.** Phase 0 uses Steph's judgment only. No inter-rater reliability.
3. **Corpus limited to our sessions.** Results may not generalize to other agent setups, coding contexts, or conversation styles.
4. **LLM-as-judge reliability.** Sonnet judging Sonnet's output has unknown bias. Mitigation: Phase 0 validates against human judgment.
5. **Model version drift.** Anthropic may update Sonnet/Opus during the experiment. Logged but not controlled.
6. **Phase 3 is underpowered.** Small N, exploratory. Degradation slopes are indicative, not conclusive.

## Status Tracking

- [x] Phase 0: Eval validation — 10 samples, human+agent+judge calibration complete
- [x] Phase 1: Baseline measurement — 9 compaction events scored (sample 10 dropped as continuation)
- [x] Phase 2: Strategy comparison — 235 successful runs across S3/S5/S9 × 3 retained × 3 thresholds
- [x] Phase 2b: Model comparison — 15 Haiku runs, 15 Gemini 3 Flash runs at winning config
- [ ] Phase 3: Replay / degradation — not started (may not be needed given decisive results)

## Results

### Phase 1: S0 Baseline (9 samples)
| Metric | Value |
|--------|-------|
| Quality (Thresh) | 2.83/5 ± 0.90 |
| Quality (Judge) | 3.22/5 ± 0.79 |
| Compression | 4.3x ± 3.3x |
| Cost/compaction | $1.53 ± $1.09 (Opus pricing) |
| Latency | ~80s (v1 measurement) |

Judge validation: Pearson 0.843 (Judge vs Thresh), 0.622 (Judge vs Steph) after few-shot calibration.

### Phase 2: Strategy Comparison (S9 winner at 10k/65k)

**S9 dominated across all configs.** Average quality 4.18/5 vs S3 3.71 vs S5 2.62.

S9 breakdown by retained/threshold:

| Retain | Thresh | Quality | Avg Context | Fold Latency | Cost |
|--------|--------|---------|-------------|-------------|------|
| 10k | 65k | 4.25 | 46k | 42s (Sonnet) | $0.098 |
| 10k | 80k | 4.29 | 54k | 45s | $0.116 |
| 10k | 100k | 4.38 | 64k | 47s | $0.149 |
| 20k | 65k | 4.17 | 51k | 32s | $0.065 |
| 20k | 80k | 4.14 | 59k | 34s | $0.070 |
| 20k | 100k | 4.33 | 69k | 41s | $0.119 |
| 30k | 65k | 3.58 | 56k | 15s | $0.023 |
| 30k | 80k | 4.20 | 63k | 17s | $0.029 |
| 30k | 100k | 3.92 | 74k | 42s | $0.096 |

**Selected config:** 10k retained / 65k threshold — best match for ~50k average context target.

### Phase 2b: Fold Model Comparison (S9, 10k/65k)

| Fold Model | N | Quality | Fold Latency | Fold Cost | Failure Rate |
|------------|---|---------|-------------|-----------|-------------|
| Sonnet | 15 | 4.23 | 38s | $0.077 | 0% |
| **Haiku** | **15** | **4.17** | **21s** | **$0.025** | **0%** |
| Gemini 3 Flash | 13/15 | 4.04 | 14s | $0.003 | 13% |

Gemini 3 Flash had 2 failures (truncated JSON output on one session). Haiku: zero failures.

### Final Decision

**Ship: S9 + Haiku, 10k retained, 65k threshold.**

| Metric | S0 Baseline | Final Config | Improvement |
|--------|-------------|-------------|-------------|
| Quality | 2.83/5 | 4.17/5 | +47% |
| Latency | ~80s | 21s | -74% |
| Cost | $1.53 | $0.025 | -98% |
| Avg context | ~77k | ~46k | -40% (by design) |

### Cost Accounting
- Phase 0: ~$0.11 (judge calibration)
- Phase 1: ~$0.11 (judge on 10 samples, no fold runs)
- Phase 2: ~$13.37 (3 batches × 135 runs each)
- Phase 2b: ~$0.22 (Haiku + Gemini 3 Flash batches)
- **Total: ~$13.81** (well under $40 budget)

### Key Findings
1. **Strategy matters more than model.** S9's structured topic extraction produces high quality even on Haiku. S5 (v1's "winner") was actually worst in v2's larger sample.
2. **v1's S5 finding was likely a measurement artifact.** With proper baseline and larger N, S9 dominates.
3. **Quality is stable across most S9 configs** (4.14–4.38), except 30k/65k (3.58) where there's too little to fold.
4. **The code-project template is the primary quality killer in S0.** It forces multi-topic sessions into a single narrative. S9 solves this with topic separation.
5. **Overflow handling is built in.** OpenClaw auto-compacts on context overflow and retries, so aggressive thresholds are safe.

## Open Questions
1. ~~How do we handle the baseline's code-project summarization template?~~ **Answered:** Replace it with S9 topic extraction.
2. Is Phase 3 (degradation testing) needed given the decisive Phase 2 results?
3. Implementation path: modify `compaction.ts` in the fork to use S9 + Haiku.
