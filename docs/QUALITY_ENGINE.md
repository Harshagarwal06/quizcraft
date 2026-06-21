# QuizCraft — Build Log & Roadmap

> A single reference for **what's built** and **what's planned** (Quality Engine
> Phases 1–3). For day-to-day contributor conventions see [`CLAUDE.md`](../CLAUDE.md);
> for setup see [`README.md`](../README.md).

---

## 1. The thesis

QuizCraft turns notes / PDFs / a topic prompt into a multiple-choice quiz with an
LLM, lets you play it one question at a time, and tracks accuracy on a dashboard.

A plain "AI generates a quiz" app is commodity — it's one LLM API call behind a
CRUD app. The **differentiator** being built here is the **Quality Engine**: a
reliability + evaluation layer that *proves and improves* the quality of LLM
output instead of trusting it. That is the scarce, currently-valuable skill, and
it's the through-line of Phases 1–3 below.

**The headline metric we're building toward:** the rate at which an independent
model finds generated questions to be wrong/ungrounded, before vs. after the
repair loop — i.e. "cut shipped error rate from X% to ~0 on played questions."

---

## 2. What's built today

### 2.1 Core app
- **Stack:** Next.js 16 (App Router, Turbopack) + React 19 + TypeScript (strict),
  Tailwind v4, Prisma 7 on the libSQL driver adapter (local SQLite file / remote
  Turso), Zod for request + LLM-output validation, Recharts for the dashboard.
- **Generation flow:** `POST /api/quizzes` → page/section-aware extraction →
  source chunks → validated blueprint → local BM25/MMR retrieval → generate and
  verify a three-question batch against cited chunks → return when the first
  batch is playable. Later batches are claimed through an idempotent API.
- **Play & scoring:** `GET /api/quizzes/[id]` serves questions with the answer key
  stripped; per-answer feedback via `…/check`; final submit via `POST /api/attempts`
  is **scored server-side** (never trust the client). Dashboard aggregates via
  `GET /api/dashboard`.
- **Providers:** pluggable behind a `QuizGenerator` interface —
  **HuggingFace** (Qwen2.5-72B-Instruct) and **Google Gemini** (structured JSON).
  Selected by `LLM_PROVIDER`. Anthropic was removed (unused).

### 2.2 Reliability work already shipped
- **Generation timeouts fixed:** scaled `max_tokens` to the question count, added
  per-call abort timeouts, and a budget-aware retry so a slow model can't blow the
  60s serverless limit.
- **Answer-position bias fixed:** `shuffleQuizOptions()` randomizes the correct
  option's letter after generation (LLMs cluster answers at A/B).
- **Automatic provider fallback:** `generateWithFallback()` tries the preferred
  provider, then the other configured one — budget-aware so a fallback never
  overruns the function limit. Recovers from fast provider failures (503/auth).
- **Dashboard performance:** batched schema DDL, cached the guest user id, and
  pushed aggregation into SQL (`GROUP BY`) so it stays fast as data grows.

### 2.3 Quality Engine — **Phase 1 (SHIPPED)**
An **independent cross-model verifier + bounded repair loop**.

**How it runs (async, decoupled from generation):**
1. Generation persists the quiz with `verificationStatus="pending"` and saves the
   exact grounding text the generator saw (`Quiz.groundingText`).
2. The player fires `POST /api/quizzes/[id]/verify` once (idempotent — a DB
   `updateMany` lock moves `pending|failed → verifying`; duplicate calls get `202`).
   It runs in its **own request / 60s budget**, because generation is already near
   its limit.
3. **Verifier** (`selectVerifier()`): picks the provider **opposite** the generator
   (e.g. generate HF → verify Gemini) for genuine independence; override with
   `VERIFIER_PROVIDER`; falls back to same-model self-check, or `skipped` if no key
   / no grounding text. It audits each question against the source:
   *grounded? answer correct & unique? distractors all wrong?*
4. **Repair loop** (`verifyAndRepair`, one bounded round):
   - wrong-but-sound answer key → **relabel the correct option in place** (`repaired`)
   - ungrounded / ambiguous / bad distractor → **regenerate + re-verify**; swap in
     if it passes, else **`flagged`**
   - otherwise → **`pass`**
5. Results persist: per-`Question` `verdict` + `verificationDetail` (JSON), and
   `Quiz.verificationSummary` / `verifierModel` / `verifiedAt`, status `verified`.

**Safety:** the play `GET` returns only the verdict **badge** (pass/repaired) — never
`verificationDetail` (it names the correct option) — and **excludes `flagged`
questions** from both play and scoring.

**UI:** a "Verifying quiz quality…" gate while it runs, then a "Quality-checked by
<model> · N checked · R repaired · F removed" chip and per-question ✓ Verified /
↻ Repaired badges.

**Verified end-to-end:** the verifier caught a wrong answer key and repaired it
(`failedInitial:1, repaired:1`); answer key never leaked; idempotent re-fire;
tolerant of HF's loose JSON.

**Key files:** `lib/llm/client.ts`, `lib/llm/verify/{types,prompt,index,repair}.ts`,
`app/api/quizzes/[id]/verify/route.ts`; play/scoring/UI edits in
`app/api/quizzes/[id]/route.ts`, `app/api/attempts/route.ts`, `app/quiz/[id]/page.tsx`.

### 2.4 Evidence-first generation pipeline — **SHIPPED**

- PDF pages and note sections are preserved in `SourceDocument` /
  `SourceChunk`.
- A validated blueprint fixes topic, objective, skill, difficulty, and seed
  chunks before question generation.
- Dependency-free BM25 plus MMR retrieves three compact evidence chunks per
  blueprint slot; the full source is never sent to the batch generator.
- Questions include option-specific rationales and one or two exact evidence
  quotes. Quotes must normalize-match their persisted chunks.
- Verification is fail-closed. Every index must receive one unique verdict;
  unresolved indexes become `unverified`, never `pass`.
- The first three verified questions unlock play. Later batches are generated
  with idempotent DB locks and can fail partially without removing ready work.
- Source planning and first-batch generation use separate client-triggered
  requests so neither operation consumes the full serverless time budget.
- Provider quota/timeout failures fall back to deterministic source coverage
  and exact-sentence questions. These emergency questions remain fail-closed:
  the alternate configured verifier must approve them before they are playable.
- Evidence is withheld from the play payload and revealed only by the
  answer-check API.
- Prompt-only quizzes prefer Gemini Search grounding with two domains and one
  authoritative source. When Gemini is unavailable or quota-exhausted, a
  key-free Wikimedia fallback supplies cited excerpts from at least two
  substantial reference pages. Existing quizzes remain evidence-free legacy
  quizzes.

**Key files:** `lib/source/*`, `lib/llm/blueprint.ts`,
`lib/pipeline/{evidence-generation,quiz-pipeline,trace}.ts`,
`app/api/quizzes/[id]/batches/route.ts`.

### 2.5 Source-grounded Study Coach Agent — **SHIPPED**

- A single active `StudyPlan` stores the exam date, target, daily availability,
  approved sources, concept map, and versioned state for the shared pilot user.
- A deterministic policy creates eligible actions from due reviews, the latest
  12 answers per concept, importance, recency, and exam urgency. Due mastery
  reviews always outrank optional work.
- The model can select one candidate ID only from that allowlist. Invalid or
  unavailable model output uses the highest-ranked deterministic action.
- Every action is a persisted proposal. Lessons, quizzes, reviews, and plan
  changes require learner confirmation; confirmation is idempotent and stale
  plan versions are rejected.
- Lessons and content chat retrieve only chunks attached to the active plan and
  require exact persisted quotes. Unsupported questions become a source request
  instead of an invented answer.
- Coach actions refresh after attempts, lesson completion, plan edits, or an
  explicit refresh. Ordinary dashboard reads do not run the planner.
- `CoachRun` captures trigger, candidates, selection, provider/model, duration,
  fallback/policy errors, and token fields when the provider supplies them.

**Key files:** `lib/coach/*`, `app/api/coach/*`,
`app/dashboard/CoachPanel.tsx`, `app/coach/lessons/[id]/*`.

---

## 3. Roadmap

### Phase 1 — Verifier + repair loop ✅ DONE
See §2.3. Outcome: no learner is scored on a known-bad question, and every quiz
records how many questions initially failed verification.

### Phase 2 — Evaluation harness & calibration ✅ DONE
**Goal:** turn ad-hoc verification into a *measured, defensible benchmark* — the
part that produces the resume number.

**What shipped:**
- **Eval dataset:** fixed in-repo source passages in `eval/datasets/phase2-sources.json`,
  including benchmark and heldout splits.
- **Calibration set:** 50 hand-labeled MCQ cases in
  `eval/datasets/calibration-cases.json`, covering correct, wrong-key,
  ungrounded, ambiguous, and invalid-distractor examples.
- **Offline-first runner:** `npm run eval` uses checked-in fixtures, makes no
  network calls, validates fixture shape, and writes JSON/Markdown reports to
  `eval/reports/phase2-latest.{json,md}`.
- **Live refresh path:** `npm run eval:live` reuses the app's configured generator,
  verifier, and bounded repair loop to refresh provider outputs when API keys are
  present.
- **Metrics:** schema validity, grounding, answer-key correctness, unique-answer
  rate, distractor validity, difficulty distribution, repair/removal rates,
  baseline error rate, and post-repair shipped-error rate with Wilson 95%
  confidence intervals. Fixed learner-state scenarios additionally gate coach
  action appropriateness, mandatory due-review compliance, unsupported-answer
  refusal, and tool-policy violations.
- **Independent eval judge:** a dedicated judge (`selectEvalJudge()`,
  `EVAL_JUDGE_PROVIDER`) scores the benchmark and is calibrated against the human
  labels — kept separate from the repair verifier so repairs aren't graded by the
  model that made them.
- **Judge calibration:** reports precision, recall, F1, accuracy, dimension-level
  agreement, and Cohen's κ against human labels.
- **Methodology:** see [`QUALITY_ENGINE_PHASE2.md`](./QUALITY_ENGINE_PHASE2.md).

**The defensible claim** (what we actually assert): the eval judge's **Cohen's κ
vs. human labels** is the credibility anchor, and the **baseline error rate** is
measured by a judge independent of the generator (cross-model). "Post-repair → ~0%"
is only cited as independent when the eval judge differs from the repair verifier
(`postRepairIndependent` in the report); otherwise it is self-consistency, not a
result. **Offline `npm run eval` numbers are synthetic plumbing tests, never cited.**

**Live numbers:** _pending a `npm run eval:live` run with `GEMINI_API_KEY` set_ —
this section will be filled with the live, calibrated κ + baseline error rate
(judge model + date) once that run completes.

### Phase 3 — Quality dashboard & regression gating ✅ DONE
**Goal:** make quality observable over time and prevent silent regressions.

**What shipped:**
- **Production-quality dashboard:** a new `GET /api/quality` aggregates the app's
  real verification data (question verdict distribution, initial-error-rate caught,
  repair/removal rates, errors-caught over time, and a by-verifier-model breakdown).
  Surfaced as a "Quality Engine" section on `/dashboard` (Recharts, existing card
  styling).
- **Provenance:** `Quiz.generatorModel`, `Quiz.generatorPromptHash`,
  `Quiz.verifierPromptHash` record which model + prompt version produced and audited
  each quiz, so quality attributes to a version (`GENERATOR_PROMPT_HASH` /
  `VERIFIER_PROMPT_HASH` are computed once at module load).
- **Regression gate:** a committed `eval/baseline.json` + `npm run eval:check`
  (offline) / `eval:check:live` fail on metric regression, dataset-integrity breaks,
  or **prompt-hash drift**. A GitHub Actions workflow (`.github/workflows/quality.yml`)
  runs lint + build + the **offline** gate on every PR (no secrets).
- **Offline vs live split (honest):** CI runs the deterministic offline gate, which
  catches harness/logic regressions and prompt drift. A true *quality* regression
  check needs a live run (`eval:check:live`, paid Gemini tier) run manually/nightly —
  free-tier quota (20/day) makes live-in-CI infeasible.

### Explicitly out of scope (for now)
- A durable job queue (QStash/Inngest) — client-triggered verification with an
  idempotent lock is sufficient for the generate-then-play flow.
- Embeddings/vector storage — BM25 retrieval is gated by recall@3 evaluation
  before additional infrastructure is justified.
- Real auth — currently bypassed (shared guest user).

---

## 4. Configuration notes

- **Providers:** `LLM_PROVIDER` = `hf` | `gemini` (generator); `VERIFIER_PROVIDER`
  optional (defaults to the provider opposite `LLM_PROVIDER` for cross-model).
- **Rollout flags:** `EVIDENCE_PIPELINE_ENABLED`, `WEB_GROUNDING_ENABLED`,
  `COACH_AGENT_ENABLED`, `COACH_AGENT_SHADOW`, and optional
  `TRUSTED_SOURCE_DOMAINS`.
- **Keys:** `HF_API_KEY`, `GEMINI_API_KEY` (+ optional `GEMINI_MODEL`). Gemini's key
  also powers topic expansion, so the whole app can run on one Gemini key.
- **Prod recommendation:** set `LLM_PROVIDER=gemini`. The HF free router (Qwen-72B)
  intermittently exceeds the 40s generation budget and causes "Couldn't generate
  the quiz"; Gemini's structured output returns reliably in ~20-25s and isn't
  subject to that variance. With Gemini as generator, the verifier stays cross-model
  (auto-selects HF) and is best-effort/non-blocking.
- **Serverless limits:** generation and verification each run in their own route
  with `maxDuration = 60`; all per-call timeouts/budgets are sized to stay under it.
- **DB migrations:** changing the model means updating `prisma/schema.prisma`, a new
  `prisma/migrations/*`, **and** the mirrored DDL in `lib/schema.ts`. New columns
  self-provision on existing (Turso) DBs via additive `ALTER`s in `ensureSchema()`.

---

## 5. Status at a glance

| Area | Status |
|---|---|
| Core app (generate / play / dashboard) | ✅ Shipped |
| Generation reliability (timeouts, shuffle, fallback) | ✅ Shipped |
| Quality Engine — Phase 1 (verifier + repair) | ✅ Shipped |
| Phase 2 — eval harness + calibration + benchmark | ✅ Shipped |
| Phase 3 — quality dashboard + regression gating + provenance | ✅ Shipped |
| Evidence-first cited generation + progressive batches | ✅ Shipped |
| Source-grounded Study Coach Agent | ✅ Shipped |
