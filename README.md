# 🎯 QuizCraft

**Evidence-grounded MCQ quiz generator.** Turn notes, PDFs, or a topic into a personalized quiz whose playable questions are verified against cited source passages.

---

## ✨ Features

- **Three input modes** — paste notes, upload a PDF, or just describe a topic.
- **Evidence-first generation** — page/section-aware chunks, a validated coverage blueprint, local BM25 retrieval, and three-question generation batches keep prompts smaller and more relevant.
- **Progressive start** — begin after the first three questions pass verification while later idempotent batches prepare in the background.
- **Explainable player** — after answering, see the explanation, why each option is right or wrong, the supporting passage, page/section, and web citations when available.
- **Verified mastery reviews** — missed concepts become fresh, quality-checked medium/hard question pairs, then return on a 1/3/7/14/30-day schedule until mastered.
- **Study Coach Agent** — set an exam goal and availability, then receive one source-grounded lesson, quiz, review, source request, or rest recommendation. Generation and plan changes always require confirmation.
- **Progress dashboard** — accuracy over time, performance by difficulty, and per-topic mastery (charts via Recharts).
- **Pilot persistence** — quizzes and attempts are saved for the shared private-pilot guest account.
- **Provider-agnostic AI** — swap the model with one env var. Ships with **HuggingFace Qwen2.5-72B-Instruct** and **Google Gemini** implementations.
- **Fail-closed Quality Engine** — every new question must receive one complete verifier verdict and valid source evidence. Missing verdicts, invalid quotes, and flagged questions never reach play or scoring.
- **Secure by design** — answer keys are never sent to the browser during play; scoring happens server-side.
- **Responsive + dark mode** — polished UI that adapts to mobile and your system theme.

## 🛠️ Tech Stack

| Layer | Tech |
|---|---|
| Framework | Next.js 16 (App Router) + React 19 + TypeScript |
| Styling | Tailwind CSS v4 |
| Database | Prisma 7 ORM + SQLite (swap for Postgres in prod) |
| Auth | Shared guest account for the private pilot; NextAuth scaffolding retained |
| AI | HuggingFace (Qwen2.5-72B) / Google Gemini, behind a provider interface |
| Charts | Recharts |
| Validation | Zod (request bodies **and** LLM output) |

## 🚀 Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy the example file and fill in your values:

```bash
cp .env.example .env.local
```

```ini
DATABASE_URL="file:./dev.db"
NEXTAUTH_SECRET="<generate with: openssl rand -base64 32>"
NEXTAUTH_URL="http://localhost:3001"
AUTH_URL="http://localhost:3001"
AUTH_TRUST_HOST="true"

# Choose your AI provider
LLM_PROVIDER="hf"               # "hf" | "gemini"
HF_API_KEY="hf_..."             # if using HuggingFace
GEMINI_API_KEY="..."            # Gemini generation and prompt-only web grounding
EVIDENCE_PIPELINE_ENABLED="true"
WEB_GROUNDING_ENABLED="true"
COACH_AGENT_ENABLED="true"
COACH_AGENT_SHADOW="false"
```

### 3. Set up the database

```bash
npx prisma migrate dev
```

### 4. Run

```bash
npm run dev
```

Open **http://localhost:3001** and generate your first quiz.

## 📁 Project Structure

```
app/
├─ (auth)/            sign in / sign up
├─ dashboard/         progress dashboard
├─ coach/             cited remediation lessons
├─ generate/          create a quiz (notes / PDF / prompt)
├─ quiz/[id]/         interactive quiz player
├─ api/               route handlers (quizzes, attempts, auth, dashboard)
└─ components/        shared UI (NavBar)
lib/
├─ coach/             bounded planner, policy, chat, lessons, and execution
├─ llm/               provider calls, blueprint generation, verification
├─ pipeline/          evidence batching, persistence, and generation traces
├─ source/            chunking, BM25/MMR retrieval, and web grounding
├─ extract/           page/section-aware PDF and notes extraction
├─ auth.ts            NextAuth config
└─ db.ts              Prisma client singleton
prisma/
└─ schema.prisma      data model
```

## 🔄 Switching AI Providers

Set `LLM_PROVIDER` in `.env.local`:

- `hf` → HuggingFace Qwen2.5-72B-Instruct (via the Inference Providers router)
- `gemini` → Google Gemini (structured JSON output)

Add your own by implementing the `QuizGenerator` interface in `lib/llm/` and registering it in `lib/llm/index.ts`.

Prompt-only evidence quizzes also require Gemini Google Search grounding. PDF and notes generation stays provider-agnostic.

## 📄 License

MIT
