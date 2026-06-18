# Quality Engine Phase 2 Methodology

Phase 2 turns the verifier and repair loop from a product feature into a
repeatable benchmark. The default run is offline and deterministic:

```bash
npm run eval
```

Use live providers only when you intentionally want to spend API calls and refresh
model outputs:

```bash
npm run eval:live
```

## Dataset

The benchmark corpus lives in `eval/datasets/phase2-sources.json`. It contains
original source passages across biology, physiology, computer science, medicine,
and web engineering, with fixed seeds and question counts. Each source is marked
as either `benchmark` or `heldout`; the heldout items include thin or tricky
material such as similar distractors and unsupported details.

Calibration cases live in `eval/datasets/calibration-cases.json`. The first set
contains 50 hand-labeled MCQ cases. Labels capture the same dimensions used by
the Phase 1 verifier:

- `grounded`
- `answerSupported`
- `uniqueAnswer`
- `distractorsValid`
- `correctOptionId`

The labels intentionally cover clean questions, wrong answer keys, ungrounded
claims, ambiguous/multiple-answer questions, and invalid distractors.

## The eval judge vs. the repair verifier (independence)

The numbers we report come from a **dedicated eval judge** that is kept separate
from the model the repair loop uses, so we don't grade repairs with the same model
that made them:

- **Repair verifier** — the app's `selectVerifier()` model; it drives the repair
  decisions (Phase 1 behaviour, unchanged).
- **Eval judge** — selected by `selectEvalJudge()` (override with
  `EVAL_JUDGE_PROVIDER`). It scores the baseline and re-judges shipped questions,
  and it is the model we **calibrate against the human labels**. Default: the
  cross-model provider opposite the generator — i.e. independent of *generation*,
  which makes the **baseline error rate** credible.

**Two-provider limitation (stated plainly):** with only HF + Gemini available, a
single judge can be independent of *generation* **or** of *repair*, not both. So:

- ✅ **Baseline error rate** is judged independently of the generator (cross-model)
  — a strong, defensible number.
- ⚠️ **Post-repair** "→ ~0%" is only an *independent* number when
  `EVAL_JUDGE_PROVIDER` is set to the provider the repair loop did **not** use
  (the report's `postRepairIndependent` flag records this). Otherwise it is the
  same model judging questions it already approved — **self-consistency, not an
  independent result** — and is labelled as such in the report.

**The defensible headline** is therefore: the eval judge's **Cohen's κ vs. human
labels** (credibility anchor) + the **baseline error rate** it catches. A fully
independent post-repair error rate needs a third model or human re-labelling of
shipped questions (future work).

## What The Eval Measures

The runner reports calibration metrics for the judge:

- accuracy, precision, recall, and F1 for binary error detection
- Cohen's kappa against human labels
- dimension-level agreement for each verifier field

The runner also reports benchmark metrics:

- schema validity rate
- grounding rate
- answer-key correctness rate
- unique-answer rate
- distractor validity rate
- difficulty distribution against the target mix
- baseline error rate with Wilson 95% confidence interval
- post-repair shipped-question error rate with Wilson 95% confidence interval
- repair rate and removal rate

Flagged questions are counted as removed. They are not included in the
post-repair shipped-error denominator, matching the app behavior that excludes
flagged questions from play and scoring.

## Offline Mode

`npm run eval` loads checked-in fixtures from `eval/fixtures/`. This mode makes no
network calls and is safe to run in local development, CI, or code review. It
writes generated reports to `eval/reports/phase2-latest.json` and
`eval/reports/phase2-latest.md`; those report files are ignored because each run
can regenerate them.

**Offline numbers are SYNTHETIC and must never be cited as results.** The baseline
verdicts in `eval/fixtures/benchmark-fixtures.json` are hand-authored, and the
offline "judge" simply echoes the human label back (with a few planted
disagreements) to exercise the scoring math. The run therefore prints a
prominent ⚠️ banner and sets `config.synthetic = true`. Offline mode exists only
to validate plumbing (schema, dataset integrity, invariants) deterministically in
CI/code review. **Real metrics require `npm run eval:live`.**

## Live Mode

`npm run eval:live` uses the configured providers:

- generator: `LLM_PROVIDER`
- repair verifier: `VERIFIER_PROVIDER`, or the same cross-model selection used by Phase 1
- eval judge: `EVAL_JUDGE_PROVIDER`, or (default) the cross-model provider opposite
  the generator — the model whose numbers are reported and calibrated

Live mode reuses the existing generation, verification, and repair contracts. It
regenerates quiz outputs, audits baseline questions **with the eval judge**, runs
the bounded repair loop **with the repair verifier**, and re-judges shipped
questions **with the eval judge** after repair.

Required environment variables are the same as the app:

- `HF_API_KEY` for HuggingFace
- `GEMINI_API_KEY` for Gemini
- optional `GEMINI_MODEL`
- optional `EVAL_JUDGE_PROVIDER` = `hf` | `gemini` (set it to the provider the
  repair loop does NOT use to get an independent post-repair number)

## Acceptance Criteria

A Phase 2 run is valid when:

- all generated or fixture quizzes pass `generatedQuizSchema`
- calibration case IDs are unique
- calibration cases reference known sources
- verifier results parse into the expected verdict schema
- report totals match dataset counts
- flagged questions are excluded from the shipped-question denominator

The calibration status is:

- `pass` when Cohen's kappa is at least 0.60
- `warning` when kappa is at least 0.40 and below 0.60
- `failed` when kappa is below 0.40
