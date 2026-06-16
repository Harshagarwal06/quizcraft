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

Offline fixture mode currently demonstrates:

- baseline error rate: 24/30
- post-repair shipped-question error rate: 0/24
- calibration kappa: 0.8369

These numbers validate the harness and metric plumbing. They should not be
presented as a broad product claim until the live run has been refreshed against
the current providers and the dataset has been expanded.

## Live Mode

`npm run eval:live` uses the configured providers:

- generator: `LLM_PROVIDER`
- verifier: `VERIFIER_PROVIDER`, or the same cross-model selection used by Phase 1

Live mode reuses the existing generation, verification, and repair contracts. It
regenerates quiz outputs, audits baseline questions, runs the bounded repair loop,
and re-judges shipped questions after repair.

Required environment variables are the same as the app:

- `HF_API_KEY` for HuggingFace
- `GEMINI_API_KEY` for Gemini
- optional `GEMINI_MODEL`

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
