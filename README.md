# 🎯 QuizCraft

**AI-powered MCQ quiz generator.** Turn your notes, PDFs, or a simple prompt into a personalized multiple-choice quiz — with mixed difficulty, per-answer explanations, balanced topic coverage, and a progress dashboard that tracks how you improve over time.

---

## ✨ Features

- **Three input modes** — paste notes, upload a PDF, or just describe a topic.
- **Smart generation** — an LLM produces MCQs with a balanced easy/medium/hard mix, plausible distractors, and an explanation for every question.
- **Interactive player** — answer one question at a time with instant feedback and explanations, a progress bar, and a final score.
- **Progress dashboard** — accuracy over time, performance by difficulty, and per-topic mastery (charts via Recharts).
- **Accounts & persistence** — sign up, and your quizzes and attempts are saved across sessions.
- **Provider-agnostic AI** — swap the model with one env var. Ships with **HuggingFace Qwen2.5-72B-Instruct** and **Google Gemini** implementations.
- **Quality Engine** — an **independent cross-model verifier** audits every generated question against its source (is the stem grounded? is the marked answer correct and unique? are the distractors wrong?) and a bounded repair loop fixes wrong answer keys, regenerates hallucinated questions, or removes the unfixable ones — so a learner is never scored on a known-bad question. Runs asynchronously with per-question trust badges.
- **Secure by design** — answer keys are never sent to the browser during play; scoring happens server-side.
- **Responsive + dark mode** — polished UI that adapts to mobile and your system theme.

## 🛠️ Tech Stack

| Layer | Tech |
|---|---|
| Framework | Next.js 16 (App Router) + React 19 + TypeScript |
| Styling | Tailwind CSS v4 |
| Database | Prisma 7 ORM + SQLite (swap for Postgres in prod) |
| Auth | NextAuth (Auth.js) v5 — credentials + JWT sessions |
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
GEMINI_API_KEY="..."            # if using Gemini (also enables topic expansion)
```

### 3. Set up the database

```bash
npx prisma migrate dev
```

### 4. Run

```bash
npm run dev
```

Open **http://localhost:3001**, create an account, and generate your first quiz.

## 📁 Project Structure

```
app/
├─ (auth)/            sign in / sign up
├─ dashboard/         progress dashboard
├─ generate/          create a quiz (notes / PDF / prompt)
├─ quiz/[id]/         interactive quiz player
├─ api/               route handlers (quizzes, attempts, auth, dashboard)
└─ components/        shared UI (NavBar)
lib/
├─ llm/               provider-agnostic generation layer (hf, gemini)
├─ extract/           PDF text extraction
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

## 📄 License

MIT
