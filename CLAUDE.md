@AGENTS.md

# QuizCraft — Guide for AI Assistants

> The `@AGENTS.md` import above is **critical**: this repo runs a build of
> Next.js whose APIs may differ from your training data. Before writing any
> Next.js code, read the relevant guide under `node_modules/next/dist/docs/`
> and heed deprecation notices. Don't assume App Router conventions from memory.

QuizCraft turns notes, PDFs, or a plain-text prompt into a multiple-choice quiz
using an LLM, lets the user play it one question at a time, and tracks accuracy
over time on a dashboard.

## Commands

```bash
npm run dev        # next dev on port 3001 (NOT 3000)
npm run build      # prisma generate && next build
npm start          # next start (production)
npm run lint       # eslint
npm run db:deploy  # apply prisma/migrations/* to a remote libSQL/Turso DB
npx prisma migrate dev   # create/apply a migration locally (file DB)
npx prisma generate      # regenerate the Prisma client (also runs postinstall)

npm run eval        # offline (synthetic) Quality-Engine eval — deterministic, no keys
npm run eval:live   # live eval (needs a Gemini key; paid tier recommended)
npm run eval:check  # offline regression gate vs eval/baseline.json (used by CI)
```

There is a **Quality-Engine eval harness** under `eval/` (Phase 2/3): `eval/run.ts`
with `--live` / `--check` flags, datasets in `eval/datasets/`, fixtures in
`eval/fixtures/`, and the regression baseline in `eval/baseline.json`. CI
(`.github/workflows/quality.yml`) runs lint + build + the offline `eval:check`
(prompt-hash drift + metric regression) on every PR. See
`docs/QUALITY_ENGINE.md` / `docs/QUALITY_ENGINE_PHASE2.md`.

Lightweight Node tests live in `tests/` and run through `npm test`. Verify
changes with `npm test`, `npm run eval:check`, `npm run lint`, `npm run build`,
and manual exercise of the relevant route/page.

## Tech stack

- **Next.js 16** (App Router, Turbopack) + **React 19** + **TypeScript** (strict)
- **Tailwind CSS v4** (`@import "tailwindcss"`; theme via CSS vars in `app/globals.css`)
- **Prisma 7** ORM with the **libSQL driver adapter** (`@prisma/adapter-libsql`)
  — one schema works for local SQLite files and remote Turso.
- **NextAuth / Auth.js v5** (present but currently bypassed — see Auth below)
- **Zod 4** for validating both request bodies **and** LLM output
- **Recharts** for dashboard charts
- Path alias: `@/*` → repo root (e.g. `@/lib/db`).

## Architecture

```
app/
  page.tsx              redirects "/" → "/dashboard"
  layout.tsx            root layout, fonts, <Providers>
  providers.tsx         next-auth SessionProvider wrapper
  components/NavBar.tsx  shared nav (client component)
  dashboard/page.tsx    progress charts (client; fetches /api/dashboard)
  dashboard/CoachPanel.tsx coach onboarding, recommendation, confirmation, chat
  coach/lessons/[id]/page.tsx cited remediation lesson
  generate/page.tsx     create a quiz: notes / PDF / prompt tabs (client)
  quiz/[id]/page.tsx    interactive player (client)
  api/
    quizzes/route.ts             POST generate quiz, GET list
    quizzes/[id]/route.ts        GET quiz for play (answer key stripped)
    quizzes/[id]/check/route.ts  POST check a single answer
    quizzes/[id]/batches/route.ts POST claim/generate the next evidence batch
    quizzes/[id]/verify/route.ts POST verify+repair quiz (Quality Engine)
    attempts/route.ts            POST submit attempt (server-scored), GET history
    dashboard/route.ts           GET aggregated learning stats
    quality/route.ts             GET Quality-Engine stats (verdicts, repair/removal, provenance)
    reviews/route.ts             POST generate a targeted verified mastery review
    coach/route.ts               GET active plan, recommendation, sources, messages
    coach/plans/route.ts         POST create the single active pilot plan
    coach/plans/[id]/route.ts    PATCH a confirmed plan change
    coach/chat/route.ts          POST grounded plan-scoped chat
    coach/refresh/route.ts       POST refresh one recommendation
    coach/actions/[id]/*         confirm or dismiss a proposal
    auth/[...nextauth]/route.ts  NextAuth handlers (unused while auth is off)
    auth/signup/route.ts         credential signup (unused while auth is off)
lib/
  db.ts            Prisma singleton + ensureSchema() self-provisioning
  schema.ts        idempotent DDL (mirrors the migration) for self-provisioning
  currentUser.ts   getCurrentUserId() — returns the shared guest user
  mastery.ts       concept normalization, scheduling, and review validation
  coach/           state snapshot, deterministic policy, bounded model planner,
                   confirmed execution, cited lessons/chat, activity refresh
  auth.ts          NextAuth config (credentials + JWT)
  extract/index.ts structured page/section extraction for text or PDF buffers
  source/          chunking, BM25/MMR retrieval, web grounding, persistence
  pipeline/        evidence-first generation batches and generation traces
  expand/index.ts  expandTopic() — Gemini topic → study-briefing pre-stage
  llm/
    index.ts       getGenerator() — picks provider from LLM_PROVIDER
    types.ts       Zod schemas + QuizGenerator interface (the contract)
    prompt.ts      shared SYSTEM_PROMPT + buildUserMessage()
    huggingface.ts HuggingFaceGenerator (Qwen2.5-72B, robust JSON salvage)
    gemini.ts      GeminiGenerator (structured JSON via responseSchema)
    shuffle.ts     shuffleQuizOptions() — randomizes correct-answer position
    client.ts      low-level callHFChat/callGeminiJSON + extractJsonLoose
    verify/        Quality Engine: cross-model verifier + repair loop
      index.ts     selectVerifier() (cross-model) + verifyQuestions()
      prompt.ts    VERIFIER_SYSTEM_PROMPT + buildVerifierMessage()
      types.ts     verdict Zod schemas + Gemini response schema
      repair.ts    verifyAndRepair() — fix wrong keys / regen / flag
prisma/
  schema.prisma    data model (provider = sqlite)
  migrations/      SQL migrations; applied to Turso via scripts/apply-migrations.mjs
scripts/apply-migrations.mjs   db:deploy target (prefers TURSO_* env vars)
```

### Quiz generation flow

For new quizzes while `EVIDENCE_PIPELINE_ENABLED` is enabled:

`generate/page.tsx` → `POST /api/quizzes` → structured extraction → persist
`SourceDocument` + page/section-aware `SourceChunk[]` → validate a complete
`QuizBlueprintItem[]` plan → local BM25/MMR retrieval → generate three questions
from only their selected chunks → fail-closed evidence verification. The
browser uses `?deferFirstBatch=1` so planning and the first verified batch run in
two separate serverless requests instead of risking the 60-second route limit.
The player calls the idempotent
`POST /api/quizzes/[id]/batches` route to prepare at most two later batches in
parallel and appends ready questions in blueprint order.

Structured calls prefer Gemini when configured because it enforces the response
schema. If model planning is unavailable, a local source-coverage blueprint is
used. If question generation is also unavailable, conservative extractive
questions are built from exact source sentences and still must pass the other
configured verifier before play.

Prompt-only quizzes first try to create a Gemini Google Search brief. Gemini
results are accepted only with grounding metadata, at least two distinct source
domains, and at least one authoritative source. If Gemini is unavailable or
quota-exhausted, a key-free fallback retrieves substantial excerpts from at
least two Wikimedia reference pages. Both paths persist source URLs and exact
supported passages, and downstream generation remains fail-closed.

Legacy quizzes remain playable and the old full-text path remains behind
`EVIDENCE_PIPELINE_ENABLED=false` for rollout rollback only.

### Playing & scoring flow

`GET /api/quizzes/[id]` returns questions **without** `correctOption` or
`explanation`. Per-answer feedback comes from `POST /api/quizzes/[id]/check`.
Final submission goes to `POST /api/attempts`, which **re-fetches the correct
answers server-side and scores there** — never trust client-supplied
correctness. The dashboard reads aggregates from `GET /api/dashboard`.

### Mastery review flow

Incorrect standard-quiz answers upsert a `ConceptReview` keyed by user + source
quiz + normalized topic. `POST /api/reviews` selects up to three weakest/oldest
due concepts and generates exactly one medium + one hard fresh question per
concept from the original `groundingText`. Review quizzes never play while
verification is pending: only complete two-question concept pairs with
`pass|repaired` verdicts are served. Two consecutive correct review answers
advance through 1/3/7/14/30-day intervals; a wrong answer resets the concept to
stage 0, due immediately. Generated review quizzes use `purpose="review"` and are
hidden from the normal quiz library.

### Study Coach Agent flow

One active `StudyPlan` links the pilot user to approved `SourceDocument`s and a
normalized `PlanConcept` map. A compact state snapshot uses the latest 12
answers per concept, due mastery reviews, source coverage, and exam proximity.
`buildCoachCandidates()` deterministically creates the eligible allowlist:
mandatory due review, remediation lesson, unseen-concept lesson, mixed quiz, or
source request. The planner model may select only one candidate ID; malformed or
failed model output falls back to the highest-ranked deterministic candidate.

The selected `CoachAction` is persisted as `proposed`. No lesson, quiz, review,
or plan mutation happens until `POST /api/coach/actions/[id]/confirm` (or a
confirmed plan PATCH). Confirmation is idempotent and rejects actions whose
captured `planStateVersion` is stale. Generation failures remain `failed` and
retryable without changing mastery. Chat searches only sources attached to the
active plan, validates exact quotes, refuses unsupported content questions, and
can propose—but not execute—actions or plan changes.

### Quality Engine (verification + repair) — async, cross-model

Legacy generation persists a quiz with `verificationStatus="pending"` and the
generator's input saved as `Quiz.groundingText`. Verification runs in a **separate
request** (its own 60s budget — generation is already near its limit), triggered
client-side by the player: `POST /api/quizzes/[id]/verify` (idempotent — an
`updateMany` lock moves `pending|failed → verifying`; double-fires get `202`).

The verifier is an **independent cross-model judge** (`selectVerifier()` picks the
provider opposite `LLM_PROVIDER`; override with `VERIFIER_PROVIDER`; falls back to
same-model self-check, or `skipped` if no key / no grounding text). It audits each
question against `groundingText` (grounded? answer correct & unique? distractors
wrong?) and `verifyAndRepair()` runs **one bounded repair round**: wrong-but-sound
answer keys are relabelled in place (`verdict="repaired"`); ungrounded/ambiguous
questions are regenerated + re-verified (swap in if they pass, else
`verdict="flagged"`); good ones are `pass`. Results: per-`Question` `verdict` +
`verificationDetail` (JSON), and `Quiz.verificationSummary`/`verifierModel`/
`verifiedAt`, status `verified`.

For evidence-backed quizzes verification is synchronous per batch and
fail-closed: each question must have exactly one complete verdict, direct
evidence support, and one or two quotes that match its retrieved chunks. Missing
or duplicate verdict indexes receive one focused retry, then become
`unverified`; `unverified` and `flagged` questions are excluded from play,
scoring, citations, mastery, and quality-checked counts.

**Never leak the answer key:** the play `GET` returns only the `verdict` badge
(pass/repaired) — never `verificationDetail` (it contains the correct option) —
and **excludes `flagged` questions** from both play and scoring.

## Conventions & patterns

- **Route handlers** import `getCurrentUserId()` from `@/lib/currentUser`, then
  scope every query by `userId` and 404 on ownership mismatch. Follow this
  pattern for any new data route.
- **Validate all input with Zod** at the top of a handler; return
  `{ error }` with `400` on failure. LLM output is validated against
  `generatedQuizSchema` before it ever touches the DB.
- **Dynamic params are async**: `{ params }: { params: Promise<{ id: string }> }`
  and `const { id } = await params;` (Next 16 convention).
- **Options are stored as a JSON string** in `Question.options`
  (`JSON.stringify([{id,text}])`); parse on read. Option ids are `"A"|"B"|"C"|"D"`.
- Pages are **client components** (`"use client"`) that fetch from the API; keep
  server-only secrets out of them.
- Generation routes set `export const dynamic = "force-dynamic"` and
  `export const maxDuration = 60` (LLM calls can take 30–40s).
- **Never send the answer key to the browser** during play.

## Database notes

- The Prisma datasource is configured **in code** (`lib/db.ts`) via the libSQL
  adapter using `DATABASE_URL` (+ optional `DATABASE_AUTH_TOKEN`), not a `url`
  in `schema.prisma`. Local dev defaults to `file:./dev.db`.
- `ensureSchema()` runs idempotent DDL once per process so a fresh Turso DB
  self-provisions on first request. **If you change the data model, update all
  three:** `prisma/schema.prisma`, a new `prisma/migrations/*`, and the mirrored
  DDL in `lib/schema.ts`.
- For remote (Turso) deploys, run `npm run db:deploy` (uses `TURSO_DATABASE_URL`
  / `TURSO_AUTH_TOKEN`, falling back to `DATABASE_URL` / `DATABASE_AUTH_TOKEN`).

## Auth (currently bypassed — important)

Real authentication is **disabled**. `getCurrentUserId()` upserts and returns a
single shared `guest@quizcraft.local` user, so every request maps to that
account. `lib/auth.ts`, the `auth/[...nextauth]` and `auth/signup` routes, and
the `User.password`/`Account`/`Session` tables remain in place but are inactive.
To re-enable real auth, prefer `(await auth()).user.id` in `getCurrentUserId()`
and fall back to the guest user only when there's no session. (Note: the README
still describes the sign-in flow; treat this file as the source of truth.)

## LLM providers

`getGenerator()` selects an implementation from `LLM_PROVIDER`:

- `hf` / `huggingface` → `HuggingFaceGenerator` (Qwen2.5-72B-Instruct via the
  HF Inference Providers OpenAI-compatible router; tolerant JSON extraction +
  salvage of truncated output, retries up to 2×). This is what `.env.example`
  ships with, and the **code default** when `LLM_PROVIDER` is unset.
- `gemini` / `google` → `GeminiGenerator` (`lib/llm/gemini.ts`; structured JSON
  output via `responseSchema`, thinking disabled, retries up to 2×). All Gemini
  call paths share a pool of up to three keys (`GEMINI_API_KEY_1..3`, preferably
  from different projects) and fail over on quota/auth errors, timeouts, network
  failures, and temporary 5xx responses. `GEMINI_API_KEY` remains supported for
  single-key deployments.

To add a provider: implement the `QuizGenerator` interface from `lib/llm/types.ts`,
reuse `SYSTEM_PROMPT`/`buildUserMessage` from `lib/llm/prompt.ts`, and register
it in `lib/llm/index.ts`. Keep the output conforming to `generatedQuizSchema`.

The generated quiz is passed through `shuffleQuizOptions()` (`lib/llm/shuffle.ts`)
in the quizzes route before persisting, so the correct answer's position is
randomized regardless of provider/model bias.

## Environment variables

See `.env.example`. Key ones:

- `DATABASE_URL` (+ `DATABASE_AUTH_TOKEN` for Turso)
- `LLM_PROVIDER` = `hf` | `gemini`
- `STRUCTURED_LLM_PROVIDER` (optional) = `hf` | `gemini`; evidence calls default
  to Gemini when its key is configured
- `VERIFIER_PROVIDER` (optional) = `hf` | `gemini` — Quality Engine judge;
  defaults to the provider opposite `LLM_PROVIDER` (cross-model)
- `EVAL_JUDGE_PROVIDER` (optional) = `hf` | `gemini` — independent judge for the
  Phase 2 eval harness (`npm run eval:live`); defaults to the provider opposite
  `LLM_PROVIDER`. Not used by the running app.
- `HF_API_KEY` (HuggingFace) / `GEMINI_API_KEY_1..3` + `GEMINI_MODEL`
  (Gemini; legacy `GEMINI_API_KEY` remains supported)
- `EVIDENCE_PIPELINE_ENABLED` (default on) — new source/blueprint/batch pipeline
- `WEB_GROUNDING_ENABLED` (default on) — prompt-only Gemini Search grounding
- `WIKIMEDIA_GROUNDING_FALLBACK` (default on) — key-free cited-excerpt fallback
  when Gemini Search is unavailable or quota-exhausted
- `TRUSTED_SOURCE_DOMAINS` — optional comma-separated authority additions
- `COACH_AGENT_ENABLED` (default on) — enable Study Coach APIs and dashboard UI
- `COACH_AGENT_SHADOW` (default off) — record planner runs without surfacing proposals
- `NEXTAUTH_SECRET` / `AUTH_SECRET`, `NEXTAUTH_URL` / `AUTH_URL`,
  `AUTH_TRUST_HOST` (read even though auth is currently bypassed)

`.env*` is gitignored except `.env.example`. Local DB files (`*.db`) are ignored.
