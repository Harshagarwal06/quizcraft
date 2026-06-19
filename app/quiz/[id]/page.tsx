"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

type Option = { id: "A" | "B" | "C" | "D"; text: string };
type Verdict = "pass" | "repaired" | null;
type Question = {
  id: string;
  stem: string;
  options: Option[];
  difficulty: "easy" | "medium" | "hard";
  topic: string;
  order: number;
  verdict: Verdict;
};
type VerificationSummary = {
  total: number;
  passedInitial: number;
  failedInitial: number;
  repaired: number;
  flagged: number;
};
type Quiz = {
  id: string;
  title: string;
  questionCount: number;
  verificationStatus: "pending" | "verifying" | "verified" | "skipped" | "failed";
  verifierModel: string | null;
  verificationSummary: VerificationSummary | null;
  questions: Question[];
};

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

const TERMINAL = new Set(["verified", "skipped", "failed"]);
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 40; // ~80s safety cap, then play with whatever we have

// Wrap Date.now() so the React Compiler's purity rule doesn't flag it
// inside event handlers (the rule pattern-matches on the global name).
const now = (): number => Date.now();

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
  // Denominator for the results screen comes from the server's scored count, not
  // the load-time questionCount — background verification may remove a flagged
  // question after play starts, which would otherwise skew the percentage.
  const [finalTotal, setFinalTotal] = useState(0);
  const [playError, setPlayError] = useState<string | null>(null);
  const questionStartMs = useRef<number>(0);
  const verifyTriggered = useRef(false);
  // Mirrors currentIdx for the background poll closure (which can't see state).
  const currentIdxRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout>;

    const triggerVerify = () => {
      if (verifyTriggered.current) return;
      verifyTriggered.current = true;
      // Fallback trigger — the generation route already fired this in the
      // background; the endpoint is idempotent (server-side lock).
      fetch(`/api/quizzes/${id}/verify`, { method: "POST" }).catch(() => {});
    };

    // Fold a fresh verification snapshot into the quiz being played WITHOUT
    // disturbing the user's current position: update verdict badges by id, and
    // drop only not-yet-reached questions that verification removed (flagged).
    // A question the user has already reached stays put; if it was flagged it is
    // simply excluded from scoring server-side.
    const mergeVerification = (data: Quiz) => {
      setQuiz((prev) => {
        if (!prev) return data;
        const byId = new Map(data.questions.map((vq) => [vq.id, vq]));
        const idx = currentIdxRef.current;
        const questions = prev.questions
          .filter((pq, i) => i <= idx || byId.has(pq.id))
          .map((pq) => {
            const vq = byId.get(pq.id);
            return vq ? { ...pq, verdict: vq.verdict } : pq;
          });
        return {
          ...prev,
          questions,
          verificationStatus: data.verificationStatus,
          verifierModel: data.verifierModel,
          verificationSummary: data.verificationSummary,
        };
      });
    };

    // Background poll: surfaces verdict badges / flagged-removal as they land.
    // Never blocks play and never sets an error — the player works regardless.
    const poll = async () => {
      if (cancelled) return;
      try {
        const r = await fetch(`/api/quizzes/${id}`);
        if (!r.ok) return;
        const data: Quiz = await r.json();
        if (cancelled) return;
        mergeVerification(data);
        if (TERMINAL.has(data.verificationStatus)) return; // settled — stop polling
      } catch {
        // transient — keep polling
      }
      if (cancelled || ++polls >= MAX_POLLS) return;
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    const load = async () => {
      try {
        const r = await fetch(`/api/quizzes/${id}`);
        if (!r.ok) throw new Error("not found");
        const data: Quiz = await r.json();
        if (cancelled) return;
        setQuiz(data);

        // Play immediately — verification runs concurrently in the background.
        setPhase("playing");
        questionStartMs.current = now();

        if (!TERMINAL.has(data.verificationStatus)) {
          if (data.verificationStatus === "pending" || data.verificationStatus === "failed") {
            triggerVerify();
          }
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch {
        if (!cancelled) setPhase("error");
      }
    };

    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id]);

  async function handleSelect(optionId: string) {
    if (!quiz || checkResult || checking) return;
    const q = quiz.questions[currentIdx];
    setChecking(true);
    setPlayError(null);
    const timeMs = now() - questionStartMs.current;

    try {
      const res = await fetch(`/api/quizzes/${id}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: q.id, selectedOption: optionId }),
      });
      if (!res.ok) throw new Error("check failed");
      const result: CheckResult = await res.json();
      setCheckResult(result);
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
    } catch {
      setPlayError("Failed to check answer. Please try again.");
    } finally {
      setChecking(false);
    }
  }

  const submitAll = useCallback(
    async (allAnswers: AnswerEntry[]) => {
      if (!quiz) return;
      setSubmitting(true);
      setPlayError(null);
      try {
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
        if (!res.ok) throw new Error("submit failed");
        const data = await res.json();
        setFinalResults(data.results);
        setFinalScore(data.score);
        setFinalTotal(data.total);
        setPhase("results");
      } catch {
        setPlayError("Failed to save results. Please try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [quiz]
  );

  function handleNext() {
    if (!quiz || !checkResult) return;
    const nextIdx = currentIdx + 1;
    if (nextIdx < quiz.questions.length) {
      currentIdxRef.current = nextIdx;
      setCurrentIdx(nextIdx);
      setCheckResult(null);
      setPlayError(null);
      questionStartMs.current = now();
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
    const pct = finalTotal > 0 ? Math.round((finalScore / finalTotal) * 100) : 0;
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
              {finalScore} of {finalTotal} correct
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

          {(quiz.verificationStatus === "pending" ||
            quiz.verificationStatus === "verifying") && (
            <div className="mt-3 flex items-center gap-1.5 text-xs text-muted">
              <svg
                className="animate-spin"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              Checking answer quality in the background…
            </div>
          )}

          {quiz.verificationStatus === "verified" && quiz.verificationSummary && (
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <span className="inline-flex items-center gap-1 font-medium text-emerald-600">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Quality-checked
              </span>
              {quiz.verifierModel && <span>by {quiz.verifierModel}</span>}
              <span>·</span>
              <span>{quiz.verificationSummary.total} checked</span>
              {quiz.verificationSummary.repaired > 0 && (
                <span>· {quiz.verificationSummary.repaired} repaired</span>
              )}
              {quiz.verificationSummary.flagged > 0 && (
                <span>· {quiz.verificationSummary.flagged} removed</span>
              )}
            </div>
          )}
        </div>

        {playError && (
          <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{playError}</p>
        )}

        <div className="card p-6">
          <div className="mb-4 flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${difficultyColor[q.difficulty]}`}>
              {q.difficulty}
            </span>
            <span className="text-xs text-muted">{q.topic}</span>
            {q.verdict === "pass" && (
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Verified
              </span>
            )}
            {q.verdict === "repaired" && (
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 4v6h-6M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
                </svg>
                Repaired
              </span>
            )}
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
