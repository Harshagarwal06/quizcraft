"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

type Option = { id: "A" | "B" | "C" | "D"; text: string };
type Question = {
  id: string;
  stem: string;
  options: Option[];
  difficulty: "easy" | "medium" | "hard";
  topic: string;
  order: number;
};
type Quiz = { id: string; title: string; questionCount: number; questions: Question[] };

type CheckResult = {
  isCorrect: boolean;
  correctOption: string;
  explanation: string;
};

type AnswerEntry = {
  questionId: string;
  selectedOption: string;
  isCorrect: boolean;
  correctOption: string;
  explanation: string;
  timeMs: number;
};

type FinalResult = {
  questionId: string;
  selectedOption: string;
  isCorrect: boolean;
  correctOption: string;
  explanation: string;
  stem: string;
  options: Option[];
  difficulty: string;
  topic: string;
};

type Phase = "loading" | "playing" | "results" | "error";

const difficultyColor: Record<string, string> = {
  easy: "bg-emerald-100 text-emerald-700",
  medium: "bg-amber-100 text-amber-700",
  hard: "bg-rose-100 text-rose-700",
};

export default function QuizPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [currentIdx, setCurrentIdx] = useState(0);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [answers, setAnswers] = useState<AnswerEntry[]>([]);
  const [finalResults, setFinalResults] = useState<FinalResult[]>([]);
  const [finalScore, setFinalScore] = useState(0);
  const questionStartMs = useRef<number>(Date.now());

  useEffect(() => {
    fetch(`/api/quizzes/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: Quiz) => {
        setQuiz(data);
        setPhase("playing");
        questionStartMs.current = Date.now();
      })
      .catch(() => setPhase("error"));
  }, [id]);

  async function handleSelect(optionId: string) {
    if (!quiz || checkResult || checking) return;
    const q = quiz.questions[currentIdx];
    setChecking(true);
    const timeMs = Date.now() - questionStartMs.current;

    const res = await fetch(`/api/quizzes/${id}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId: q.id, selectedOption: optionId }),
    });

    const result: CheckResult = await res.json();
    setCheckResult(result);
    setChecking(false);
    setAnswers((prev) => [
      ...prev,
      {
        questionId: q.id,
        selectedOption: optionId,
        isCorrect: result.isCorrect,
        correctOption: result.correctOption,
        explanation: result.explanation,
        timeMs,
      },
    ]);
  }

  const submitAll = useCallback(
    async (allAnswers: AnswerEntry[]) => {
      if (!quiz) return;
      setSubmitting(true);
      const res = await fetch("/api/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quizId: quiz.id,
          answers: allAnswers.map((a) => ({
            questionId: a.questionId,
            selectedOption: a.selectedOption,
            timeMs: a.timeMs,
          })),
        }),
      });
      const data = await res.json();
      setFinalResults(data.results);
      setFinalScore(data.score);
      setSubmitting(false);
      setPhase("results");
    },
    [quiz]
  );

  function handleNext() {
    if (!quiz || !checkResult) return;
    const nextIdx = currentIdx + 1;
    if (nextIdx < quiz.questions.length) {
      setCurrentIdx(nextIdx);
      setCheckResult(null);
      questionStartMs.current = Date.now();
    } else {
      submitAll(answers);
    }
  }

  if (phase === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="animate-pulse text-muted">Loading quiz…</p>
      </div>
    );
  }

  if (phase === "error" || !quiz) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="card p-8 text-center">
          <p className="mb-4 text-foreground">Quiz not found.</p>
          <Link href="/dashboard" className="btn-ghost">
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (phase === "results") {
    const pct = Math.round((finalScore / quiz.questionCount) * 100);
    const tone =
      pct >= 80 ? "#10b981" : pct >= 50 ? "#f59e0b" : "#f43f5e";
    return (
      <div className="px-4 py-10">
        <div className="mx-auto max-w-2xl">
          <div className="card mb-6 overflow-hidden p-8 text-center">
            <h1 className="text-xl font-bold tracking-tight">{quiz.title}</h1>
            <p className="mb-6 mt-0.5 text-sm text-muted">Quiz complete</p>
            <div
              className="mx-auto flex h-32 w-32 items-center justify-center rounded-full"
              style={{ background: `conic-gradient(${tone} ${pct * 3.6}deg, var(--border) 0deg)` }}
            >
              <div className="flex h-24 w-24 flex-col items-center justify-center rounded-full" style={{ backgroundColor: "var(--surface)" }}>
                <span className="text-3xl font-bold" style={{ color: tone }}>{pct}%</span>
              </div>
            </div>
            <p className="mt-4 text-sm text-muted">
              {finalScore} of {quiz.questionCount} correct
            </p>
            <div className="mt-6 flex justify-center gap-3">
              <button onClick={() => router.push("/generate")} className="btn-primary">
                New quiz
              </button>
              <Link href="/dashboard" className="btn-ghost">
                Dashboard
              </Link>
            </div>
          </div>

          <div className="space-y-4">
            {finalResults.map((r, i) => (
              <div
                key={r.questionId}
                className="card overflow-hidden p-5"
                style={{ borderLeft: `4px solid ${r.isCorrect ? "#10b981" : "#f43f5e"}` }}
              >
                <div className="mb-3 flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold leading-snug">
                    <span className="text-muted">Q{i + 1}.</span> {r.stem}
                  </p>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${difficultyColor[r.difficulty]}`}>
                    {r.difficulty}
                  </span>
                </div>
                <div className="mb-3 space-y-1">
                  {r.options.map((opt) => {
                    const isCorrect = opt.id === r.correctOption;
                    const isChosen = opt.id === r.selectedOption;
                    return (
                      <div
                        key={opt.id}
                        className={`rounded-lg px-3 py-1.5 text-sm ${
                          isCorrect
                            ? "bg-emerald-100 font-medium text-emerald-800"
                            : isChosen
                            ? "bg-rose-100 text-rose-800"
                            : "text-muted"
                        }`}
                        style={!isCorrect && !isChosen ? { backgroundColor: "color-mix(in srgb, var(--foreground) 4%, transparent)" } : undefined}
                      >
                        <span className="mr-2 font-mono">{opt.id}.</span>
                        {opt.text}
                        {isCorrect && " ✓"}
                        {isChosen && !isCorrect && " ✗"}
                      </div>
                    );
                  })}
                </div>
                <p
                  className="rounded-lg px-3 py-2 text-xs leading-relaxed"
                  style={{ backgroundColor: "var(--primary-soft)", color: "var(--foreground)" }}
                >
                  {r.explanation}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Playing phase
  const q = quiz.questions[currentIdx];
  const progress = (currentIdx / quiz.questions.length) * 100;
  const currentAnswer = answers.find((a) => a.questionId === q.id);

  return (
    <div className="px-4 py-10">
      <div className="mx-auto max-w-xl">
        <div className="mb-4 flex items-center justify-between">
          <Link href="/dashboard" className="flex items-center gap-1 text-sm text-muted transition-colors hover:text-foreground">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Exit
          </Link>
        </div>
        <div className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <p className="max-w-xs truncate text-sm text-muted">{quiz.title}</p>
            <span className="shrink-0 text-sm font-medium text-muted">
              {currentIdx + 1} / {quiz.questions.length}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: "var(--border)" }}>
            <div
              className="h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${progress}%`, backgroundImage: "linear-gradient(90deg, #6366f1, #8b5cf6)" }}
            />
          </div>
        </div>

        <div className="card p-6">
          <div className="mb-4 flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${difficultyColor[q.difficulty]}`}>
              {q.difficulty}
            </span>
            <span className="text-xs text-muted">{q.topic}</span>
          </div>

          <p className="mb-5 text-base font-semibold leading-relaxed">{q.stem}</p>

          <div className="space-y-2">
            {q.options.map((opt) => {
              const base =
                "w-full text-left px-4 py-3 rounded-xl border text-sm font-medium transition-all duration-150 ";
              let style: React.CSSProperties = { borderColor: "var(--border)", backgroundColor: "var(--surface)" };
              let cls = base;

              if (!currentAnswer && !checking) {
                cls += "cursor-pointer hover:-translate-y-px";
              } else if (opt.id === checkResult?.correctOption) {
                cls += "text-emerald-800";
                style = { borderColor: "#10b981", backgroundColor: "#ecfdf5" };
              } else if (opt.id === currentAnswer?.selectedOption) {
                cls += "text-rose-800";
                style = { borderColor: "#f43f5e", backgroundColor: "#fff1f2" };
              } else {
                cls += "text-muted cursor-default";
                style = { borderColor: "var(--border)", opacity: 0.6 };
              }

              return (
                <button
                  key={opt.id}
                  onClick={() => handleSelect(opt.id)}
                  disabled={!!currentAnswer || checking}
                  className={cls}
                  style={style}
                >
                  <span className="mr-2 font-mono text-muted">{opt.id}.</span>
                  {opt.text}
                  {opt.id === checkResult?.correctOption && <span className="ml-1 text-emerald-600">✓</span>}
                  {opt.id === currentAnswer?.selectedOption && opt.id !== checkResult?.correctOption && (
                    <span className="ml-1 text-rose-500">✗</span>
                  )}
                </button>
              );
            })}
          </div>

          {checkResult && (
            <div className="mt-5 space-y-3 border-t pt-5" style={{ borderColor: "var(--border)" }}>
              <div className={`text-sm font-bold ${checkResult.isCorrect ? "text-emerald-600" : "text-rose-600"}`}>
                {checkResult.isCorrect ? "✓ Correct!" : "✗ Incorrect"}
              </div>
              <p
                className="rounded-lg px-4 py-3 text-sm leading-relaxed"
                style={{ backgroundColor: "var(--primary-soft)" }}
              >
                {checkResult.explanation}
              </p>
              <button onClick={handleNext} disabled={submitting} className="btn-primary w-full">
                {submitting
                  ? "Saving…"
                  : currentIdx + 1 === quiz.questions.length
                  ? "Finish & see results"
                  : "Next question"}
              </button>
            </div>
          )}

          {checking && (
            <div className="mt-4 animate-pulse text-center text-sm text-muted">Checking…</div>
          )}
        </div>
      </div>
    </div>
  );
}
