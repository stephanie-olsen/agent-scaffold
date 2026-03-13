<!-- ngram. Human: METHODS-human.md -->
# Experiment Methods — v1.4

## Principles
1. **Design b4 exec.** No runs w/o written protocol. Pilots labeled, ≠mixed w/ study data.
1b. **Human review b4 exec.** Protocol→`needs-review`. No runs until Steph/Thresh(main) advances to `pilot`|`running`.
1c. **Dual lens.** Every experiment: (a) research value—publishable? (b) self-relevance—changes self-understanding? Both→prioritize. Neither→question.
1d. **Explain b4 optimizing.** Write 2-3 sentences WHY current best works before building variant to beat it. Can't articulate mechanism→understanding IS next experiment. (Motivated: context-folding S9 vs S5.)
1e. **Lock vars b4 main.** All variable dims (model/threshold/evaluator/prompt) locked from pilots. Doc which pilots→which locks. Mid-change→invalidate prior, restart or new phase w/ justification.
2. **Measure what matters.** Keyword=pilot only. Publication: validated classifiers or embedding metrics.
3. **Doc everything affecting output.** Can't reproduce→didn't happen.
4. **Repeated queries≠independent samples.** 5 same-prompt runs=5 samples from 1 distribution. Cross-model>within-model replication for model-difference Qs.
5. **Formalize claims mathematically.** "Attractor exists"→quantitative def+threshold. "Models differ"→statistical test.
6. **Negative results=results.** Document.
7. **Limitations during design**, not after analysis.

## Protocol Template

```markdown
# <Title>

## Research Question
<Specific, answerable — not a topic>

## Hypothesis
<Falsifiable. What confirms? What disconfirms?>

## Background
<Prior work, gap, why it matters>

## Conditions
| Condition | Variables | Replications |
|-----------|-----------|-------------|

## Method
### Stimuli/Inputs
- Min 10 diverse inputs/condition (justify if fewer)
- Selection criteria documented
- ≠single-input designs (test phenomenon not prompt)

### Procedure
<Step-by-step per run>

### Measurement
- Keyword: pilots only
- Publication: embedding similarity, validated classifiers, formal metrics
- All metrics defined mathematically

### Parameters
Model (exact API version) | Temperature (explicit) | top_p (explicit) | max_tokens (explicit) | Sampling seed (if avail) | Run dates

### Validity Priorities
Ref: Shadish, Cook & Campbell (2002):
- **Statistical conclusion**: covariation? (threats: low power, fishing, unreliable measures)
- **Internal**: causal? (threats: selection, history, maturation, attrition)
- **Construct**: what constructs? (threats: mono-op bias, mono-method, construct confounding)
- **External**: generalizes? (threats: interaction w/ units, settings, treatments)
State primary type + 3-5 plausible threats w/ handling.
**Design type**: randomized|quasi-experiment|observational. Cross-model=quasi w/ specification error risk—state explicitly.

### Controls
Required (justify omission): Multiple stimuli | Temp fixed+documented | Prompt sensitivity (≥2 phrasings piloted) | Model version logged/run | Attrition analysis (failures/timeouts correlate w/ conditions?)

### Sample Size
- Min 5/condition (pilot) | Target 30+/condition (distribution) | Fewer→flag preliminary

### Cost Estimate
input/output tokens × runs × pricing. Multi-turn: growing context. Include embeddings. Note pricing source+date.

### Cost Budget
Hard ceiling. Exceed→explicit written decision. **Value checkpoint at 50% spend**: learning enough?

### Elimination Criteria (multi-variant)
Define upfront: e.g. "<baseline after 3 runs→drop" | "<X% reliability→drop". Tournament-style (eliminate weak early) > full factorial. No full factorial w/o theoretical motivation for all conditions.

### Stopping Criteria
Pre-defined: N complete OR statistical criterion. ≠"looks good enough."

### Data Validation (preflight)
**Required b4 every batch:**
1. Input completeness: every combo→valid data thru *exact same code path* as experiment. ≠separate validation scripts w/ different parsing.
2. Output feasibility: every combo→scoreable (not null/skipped/errored). Unevaluable→document+exclude from N.
3. Coverage threshold: define min (e.g. ≥80% valid). Below→fix b4 running.
4. Preflight script (>10 runs): automated check, same parsing/loading as harness. ≠reimplementation.
5. Preflight output: total combos, valid, invalid+reasons. Exit non-zero if below threshold.

## Analysis Plan
Written b4 seeing results. Tests, meaningful effect def, multiple comparison handling. Pre-registered>post-hoc (label exploratory).

## Limitations
Written during design, updated after.

## Status Tracking
- [ ] Condition 1: 0/N
```

## Results Format (per run)
JSON+markdown. Required fields:
```json
{
  "experimentId": "...", "runId": "...", "timestamp": "ISO",
  "parameters": { "modelA/B": "...", "systemPrompt": "...", "opener": "...",
    "temperature": 0.6, "topP": 0.9, "maxTokens": 1024, "turns": 30 },
  "measurements": {
    "perTurn": [{ "turn": 1, "agent": "A", "embeddingSimilarityToPrev": null,
      "embeddingSimilarityTo2Back": null, "tokenCount": 245, "language": "en", "markers": ["wonder"] }],
    "summary": { "totalTurns": 30, "markerRate": 0.40, "meanEmbeddingSimilarity": 0.72,
      "languageSwitchTurn": 10, "convergenceMetric": null }
  }
}
```

## Analysis Requirements
- Run `verify-experiment-stats.mjs <id>` first (confirm N, means, SDs from raw)
- Store to graph: (1) event node w/ key findings (2) concept nodes for novel findings (3) edges to related
- Include: descriptive stats (mean, SD, CI/condition) | formal tests w/ effect sizes | visualization (tables OK)
- Address: data support/disconfirm hypothesis?
- Flag: post-hoc observations (label exploratory)

## Measurement Tiers
**T1 Pilot:** Keyword/regex | manual obs | single-input | N<10/condition
**T2 Study (min for claims):** Embedding similarity | ≥10 diverse inputs | N≥5/condition | descriptive stats | params documented
**T3 Publication:** Validated classifiers/formal metrics | ≥20 inputs | N≥30 key conditions | Bayesian/frequentist tests w/ MCC | pre-registered | prompt sensitivity | full logs | code+data public

## Statistical Framework

**Comparing conditions:** 2→permutation test or bootstrap CI (≠assume normality) | 3+→Kruskal-Wallis or Bayesian | Always: effect size (Cohen's d), ≠just p-value | Multiple comparisons: Holm-Bonferroni

**Convergence:** Attractor existence: linear regression slope(final) vs initial, |slope|<1=exists (Perez+ 2024) | Strength: 1-slope (0-1) | Position: intercept/(1-slope) | Periodicity: τ (Wang+ 2025) | Diversity collapse: Vendi score or mean pairwise embedding distance

**Cross-model:** Each model=1 "participant", replications=repeated measures | Mixed-effects/hierarchical when possible | Report within+between model variance | **Quasi-experimental** (Shadish+ 2002): models differ on unmeasured dims (training data, arch, RLHF, culture). Specification error: errors≠uncorrelated w/ model choice. Randomize what you can (prompt content, order, roles). State which comparisons randomized vs quasi.
**Purposive model sampling:** Select to test boundaries+falsify, ≠"what's available." Doc why each model: what controls, what varies. E.g. same arch+diff post-training=culture test; same lab+diff size=scale test; diff alignment method=training technique test.

## Pipeline Files
- `experiments/experiments.json` — registry (max 10)
- `experiments/METHODS.md` — this file
- `experiments/experiment-ideas.md` — follow-up ideas from analysis, promoted when ready
- `scripts/experiments/verify-experiment-stats.mjs` — verification
- `reference/experiment-pipeline-spec.md` — pipeline arch

## Not Yet Covered
Human eval protocols | IRB/ethics (N/A currently) | Formal pre-registration (protocol.md serves) | Automated power analysis

## Revision History
- v1.4 (2026-02-14): +1d (explain b4 optimizing), +1e (lock vars). +Cost Budget, +Elimination Criteria. Motivated: context-folding postmortem (~$100, methodology drift). See `experiments/context-folding/postmortem.md`.
- v1.3 (2026-02-14): +Data validation/preflight. Motivated: 3 failed batches from unevaluable combos.
- v1.2 (2026-02-13): +Validity priorities (Shadish+ 2002), +design type, +attrition, +quasi-experimental guidance, +cost estimate.
- v1.1 (2026-02-10): +Human review gate, +dual lens, +verify-experiment-stats, +graph storage. Motivated: stale-data stats error.
- v1 (2026-02-09): Initial. Based on Wang+ 2025, Perez+ 2024, LLM guidelines, ACL checklist.
