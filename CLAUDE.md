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
```

There is **no test suite**. Verify changes with `npm run lint`, `npm run build`,
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
  generate/page.tsx     create a quiz: notes / PDF / prompt tabs (client)
  quiz/[id]/page.tsx    interactive player (client)
  api/
    quizzes/route.ts             POST generate quiz, GET list
    quizzes/[id]/route.ts        GET quiz for play (answer key stripped)
    quizzes/[id]/check/route.ts  POST check a single answer
    attempts/route.ts            POST submit attempt (server-scored), GET history
    dashboard/route.ts           GET aggregated stats
    auth/[...nextauth]/route.ts  NextAuth handlers (unused while auth is off)
    auth/signup/route.ts         credential signup (unused while auth is off)
lib/
  db.ts            Prisma singleton + ensureSchema() self-provisioning
  schema.ts        idempotent DDL (mirrors the migration) for self-provisioning
  currentUser.ts   getCurrentUserId() — returns the shared guest user
  auth.ts          NextAuth config (credentials + JWT)
  extract/index.ts extractText() for raw text or PDF buffers (pdf-parse)
  expand/index.ts  expandTopic() — Gemini topic → study-briefing pre-stage
  llm/
    index.ts       getGenerator() — picks provider from LLM_PROVIDER
    types.ts       Zod schemas + QuizGenerator interface (the contract)
    prompt.ts      shared SYSTEM_PROMPT + buildUserMessage()
    anthropic.ts   AnthropicGenerator (json_schema structured output)
    huggingface.ts HuggingFaceGenerator (Qwen2.5-72B, robust JSON salvage)
prisma/
  schema.prisma    data model (provider = sqlite)
  migrations/      SQL migrations; applied to Turso via scripts/apply-migrations.mjs
scripts/apply-migrations.mjs   db:deploy target (prefers TURSO_* env vars)
```

### Quiz generation flow

`generate/page.tsx` → `POST /api/quizzes` → `extractText()` →
**optional `expandTopic()`** → `getGenerator().generate()` → Zod-validate the LLM
output → persist `Quiz` + `Question[]` → return `{ id }`. The client then
navigates to `/quiz/[id]`.

**Topic-expansion pre-stage** (`lib/expand/index.ts`): when `sourceType` is
`"prompt"` **or** the extracted text is thin (< `THIN_INPUT_CHARS`, 500), the
input is first sent to Google **Gemini** to produce a detailed, factual study
briefing, which becomes the `sourceText` fed to the generator. This grounds the
quiz in richer material. It is **best-effort with graceful fallback**: if
`GEMINI_API_KEY` is unset, or Gemini errors/times out (20s cap), the raw input is
used instead. `Quiz.sourceSummary` always stores the **original** input, not the
expanded briefing.

### Playing & scoring flow

`GET /api/quizzes/[id]` returns questions **without** `correctOption` or
`explanation`. Per-answer feedback comes from `POST /api/quizzes/[id]/check`.
Final submission goes to `POST /api/attempts`, which **re-fetches the correct
answers server-side and scores there** — never trust client-supplied
correctness. The dashboard reads aggregates from `GET /api/dashboard`.

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

- `anthropic` → `AnthropicGenerator` (model `claude-opus-4-8`, structured
  `json_schema` output). **Code default** when `LLM_PROVIDER` is unset.
- `hf` / `huggingface` → `HuggingFaceGenerator` (Qwen2.5-72B-Instruct via the
  HF Inference Providers OpenAI-compatible router; tolerant JSON extraction +
  salvage of truncated output, retries up to 2×). This is what `.env.example`
  ships with.

To add a provider: implement the `QuizGenerator` interface from `lib/llm/types.ts`,
reuse `SYSTEM_PROMPT`/`buildUserMessage` from `lib/llm/prompt.ts`, and register
it in `lib/llm/index.ts`. Keep the output conforming to `generatedQuizSchema`.

When touching Anthropic/LLM code, follow the repo's LLM guidance and use the
latest capable Claude models (default `claude-opus-4-8`).

## Environment variables

See `.env.example`. Key ones:

- `DATABASE_URL` (+ `DATABASE_AUTH_TOKEN` for Turso)
- `LLM_PROVIDER` = `hf` | `anthropic`
- `HF_API_KEY` (HuggingFace) / `ANTHROPIC_API_KEY` (Anthropic)
- `GEMINI_API_KEY` (optional; enables the topic-expansion pre-stage) +
  `GEMINI_MODEL` (optional, default `gemini-2.5-flash`)
- `NEXTAUTH_SECRET` / `AUTH_SECRET`, `NEXTAUTH_URL` / `AUTH_URL`,
  `AUTH_TRUST_HOST` (read even though auth is currently bypassed)

`.env*` is gitignored except `.env.example`. Local DB files (`*.db`) are ignored.
