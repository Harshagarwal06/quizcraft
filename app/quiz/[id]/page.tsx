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
  reviewConceptKey: string | null;
};
type VerificationSummary = {
  total: number;
  passedInitial: number;
  failedInitial: number;
  repaired: number;
  flagged: number;
  unverified?: number;
};
type Evidence = {
  quote: string;
  sourceTitle: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  url: string | null;
};
type Quiz = {
  id: string;
  title: string;
  purpose: "standard" | "review";
  sourceQuizId: string | null;
  questionCount: number;
  verificationStatus: "pending" | "verifying" | "verified" | "skipped" | "failed";
  verifierModel: string | null;
  verificationSummary: VerificationSummary | null;
  reviewReadiness: {
    status: "preparing" | "ready" | "unavailable";
    reason: string | null;
  } | null;
  evidenceAvailable: boolean;
  generation: {
    status:
      | "legacy"
      | "preparing"
      | "first_batch_ready"
      | "complete"
      | "partial"
      | "failed";
    readyCount: number;
    targetCount: number;
    pendingBatchCount: number;
    failedBatchCount: number;
    hasMore: boolean;
  };
  questions: Question[];
};

type CheckResult = {
  isCorrect: boolean;
  correctOption: string;
  explanation: string;
  optionExplanations: Record<string, string> | null;
  evidence: Evidence[];
};

type AnswerEntry = {
  questionId: string;
  selectedOption: string;
  isCorrect: boolean;
  correctOption: string;
  explanation: string;
  optionExplanations?: Record<string, string> | null;
  evidence?: Evidence[];
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
  optionExplanations?: Record<string, string> | null;
  evidence?: Evidence[];
};

type MasteryChange = {
  conceptKey: string;
  label: string;
  previousStage: number;
  stage: number;
  status: "advanced" | "reset" | "progress" | "unchanged";
  dueAt: string | null;
  mastered: boolean;
  consecutiveCorrect: number;
};

type Phase =
  | "loading"
  | "preparing"
  | "playing"
  | "results"
  | "unavailable"
  | "error";

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
  const [masteryChanges, setMasteryChanges] = useState<MasteryChange[]>([]);
  const [canPracticeMistakes, setCanPracticeMistakes] = useState(false);
  const [canContinueReview, setCanContinueReview] = useState(false);
  const [nextDueAt, setNextDueAt] = useState<string | null>(null);
  const [resultSourceQuizId, setResultSourceQuizId] = useState<string | null>(null);
  const [reviewActionLoading, setReviewActionLoading] = useState(false);
  const [reviewActionError, setReviewActionError] = useState<string | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const questionStartMs = useRef<number>(0);
  const verifyTriggered = useRef(false);
  const batchRequestInFlight = useRef(false);
  // Mirrors currentIdx for the background poll closure (which can't see state).
  const currentIdxRef = useRef(0);

  const mergeQuizSnapshot = useCallback((data: Quiz) => {
    setQuiz((previous) => {
      if (!previous) return data;
      if (data.evidenceAvailable) {
        const questions = [...data.questions].sort((a, b) => a.order - b.order);
        return { ...previous, ...data, questions };
      }
      const byId = new Map(data.questions.map((question) => [question.id, question]));
      const index = currentIdxRef.current;
      const questions = previous.questions
        .filter((question, questionIndex) => questionIndex <= index || byId.has(question.id))
        .map((question) => byId.get(question.id) ?? question);
      return { ...previous, ...data, questions };
    });
  }, []);

  const requestMoreBatches = useCallback(
    async (retryFailed = false) => {
      if (batchRequestInFlight.current) return;
      batchRequestInFlight.current = true;
      setBatchLoading(true);
      setBatchError(null);
      try {
        const response = await fetch(`/api/quizzes/${id}/batches`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ retryFailed }),
        });
        const result = await response.json().catch(() => null);
        if (!response.ok && response.status !== 202) {
          throw new Error(result?.error ?? "Couldn't prepare more questions.");
        }
        const snapshotResponse = await fetch(`/api/quizzes/${id}`);
        if (snapshotResponse.ok) {
          mergeQuizSnapshot((await snapshotResponse.json()) as Quiz);
        }
      } catch (error) {
        setBatchError(
          error instanceof Error ? error.message : "Couldn't prepare more questions."
        );
      } finally {
        batchRequestInFlight.current = false;
        setBatchLoading(false);
      }
    },
    [id, mergeQuizSnapshot]
  );

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

    const poll = async () => {
      if (cancelled) return;
      try {
        const r = await fetch(`/api/quizzes/${id}`);
        if (!r.ok) return;
        const data: Quiz = await r.json();
        if (cancelled) return;
        mergeQuizSnapshot(data);
        if (data.purpose === "review") {
          if (data.reviewReadiness?.status === "ready") {
            setPhase("playing");
          } else if (data.reviewReadiness?.status === "unavailable") {
            setPhase("unavailable");
          }
        }
        const keepPolling = data.evidenceAvailable
          ? data.generation.hasMore || batchRequestInFlight.current
          : !TERMINAL.has(data.verificationStatus);
        if (
          data.evidenceAvailable &&
          data.generation.hasMore &&
          !batchRequestInFlight.current
        ) {
          void requestMoreBatches();
        }
        if (!keepPolling) return;
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

        if (data.purpose === "review") {
          if (data.reviewReadiness?.status === "ready") {
            setPhase("playing");
            questionStartMs.current = now();
          } else if (data.reviewReadiness?.status === "unavailable") {
            setPhase("unavailable");
          } else {
            setPhase("preparing");
          }
        } else {
          setPhase("playing");
          questionStartMs.current = now();
        }

        if (data.evidenceAvailable) {
          if (data.generation.hasMore) {
            void requestMoreBatches();
            timer = setTimeout(poll, POLL_INTERVAL_MS);
          }
        } else if (!TERMINAL.has(data.verificationStatus)) {
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
  }, [id, mergeQuizSnapshot, requestMoreBatches]);

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
          optionExplanations: result.optionExplanations,
          evidence: result.evidence,
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
        const evidenceByQuestion = new Map(
          allAnswers.map((answer) => [answer.questionId, answer])
        );
        setFinalResults(
          data.results.map((result: FinalResult) => ({
            ...result,
            optionExplanations:
              evidenceByQuestion.get(result.questionId)?.optionExplanations,
            evidence: evidenceByQuestion.get(result.questionId)?.evidence,
          }))
        );
        setFinalScore(data.score);
        setFinalTotal(data.total);
        setMasteryChanges(data.masteryChanges ?? []);
        setCanPracticeMistakes(Boolean(data.canPracticeMistakes));
        setCanContinueReview(Boolean(data.canContinueReview));
        setNextDueAt(data.nextDueAt ?? null);
        setResultSourceQuizId(data.sourceQuizId ?? null);
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
    } else if (quiz.evidenceAvailable && quiz.generation.hasMore) {
      void requestMoreBatches();
    } else {
      submitAll(answers);
    }
  }

  async function createReview(sourceQuizId: string | null) {
    if (!sourceQuizId || reviewActionLoading) return;
    setReviewActionLoading(true);
    setReviewActionError(null);
    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceQuizId }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Couldn't prepare the review.");
      }
      router.push(`/quiz/${data.id}`);
    } catch (error) {
      setReviewActionError(
        error instanceof Error ? error.message : "Couldn't prepare the review."
      );
    } finally {
      setReviewActionLoading(false);
    }
  }

  async function retryVerification() {
    if (!quiz || reviewActionLoading) return;
    setReviewActionLoading(true);
    setReviewActionError(null);
    setPhase("preparing");
    try {
      const response = await fetch(`/api/quizzes/${quiz.id}/verify`, {
        method: "POST",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? "Verification failed again.");
      }
      window.location.reload();
    } catch (error) {
      setPhase("unavailable");
      setReviewActionError(
        error instanceof Error ? error.message : "Verification failed again."
      );
      setReviewActionLoading(false);
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

  if (phase === "preparing") {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="card max-w-md p-8 text-center">
          <div
            className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-t-transparent"
            style={{ borderColor: "var(--primary-soft)", borderTopColor: "var(--primary)" }}
          />
          <h1 className="text-xl font-bold">Preparing verified review</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Every question must pass the Quality Engine before it can change your
            mastery schedule.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "unavailable") {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="card max-w-md p-8 text-center">
          <h1 className="text-xl font-bold">Review needs another pass</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            {quiz.reviewReadiness?.reason ??
              "This review does not yet have a complete verified question pair."}
          </p>
          {reviewActionError && (
            <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {reviewActionError}
            </p>
          )}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
            {quiz.verificationStatus === "failed" && (
              <button
                onClick={retryVerification}
                disabled={reviewActionLoading}
                className="btn-primary"
              >
                {reviewActionLoading ? "Retrying…" : "Retry verification"}
              </button>
            )}
            <button
              onClick={() => createReview(quiz.sourceQuizId)}
              disabled={reviewActionLoading}
              className="btn-ghost"
            >
              Generate fresh review
            </button>
            <Link href="/dashboard" className="btn-ghost">
              Dashboard
            </Link>
          </div>
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
            {quiz.purpose === "review" && masteryChanges.length > 0 && (
              <div className="mt-6 space-y-2 text-left">
                {masteryChanges.map((change) => (
                  <div
                    key={change.conceptKey}
                    className="rounded-xl px-4 py-3 text-sm"
                    style={{ backgroundColor: "var(--surface-sunk)" }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold">{change.label}</span>
                      <span
                        className={
                          change.status === "advanced"
                            ? "text-emerald-600"
                            : change.status === "reset"
                              ? "text-rose-600"
                              : "text-muted"
                        }
                      >
                        {change.mastered
                          ? "Mastered"
                          : change.status === "advanced"
                            ? `Stage ${change.stage}`
                            : change.status === "reset"
                              ? "Review again"
                              : `${change.consecutiveCorrect}/2 correct`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {quiz.purpose === "review" && nextDueAt && !canContinueReview && (
              <p className="mt-4 text-sm text-muted">
                Next review: {new Date(nextDueAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
            )}
            {reviewActionError && (
              <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
                {reviewActionError}
              </p>
            )}
            <div className="mt-6 flex justify-center gap-3">
              {quiz.purpose === "standard" && canPracticeMistakes ? (
                <button
                  onClick={() => createReview(quiz.id)}
                  disabled={reviewActionLoading}
                  className="btn-primary"
                >
                  {reviewActionLoading ? "Preparing…" : "Practice my mistakes"}
                </button>
              ) : quiz.purpose === "review" && canContinueReview ? (
                <button
                  onClick={() => createReview(resultSourceQuizId)}
                  disabled={reviewActionLoading}
                  className="btn-primary"
                >
                  {reviewActionLoading ? "Preparing…" : "Continue review"}
                </button>
              ) : (
                <button onClick={() => router.push("/generate")} className="btn-primary">
                  New quiz
                </button>
              )}
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
                {r.evidence && r.evidence.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {r.evidence.map((evidence, evidenceIndex) => (
                      <div
                        key={`${r.questionId}-evidence-${evidenceIndex}`}
                        className="rounded-lg border px-3 py-2 text-xs leading-relaxed"
                        style={{ borderColor: "var(--border)" }}
                      >
                        <p>&ldquo;{evidence.quote}&rdquo;</p>
                        <p className="mt-1 text-muted">
                          {evidence.url ? (
                            <a
                              href={evidence.url}
                              target="_blank"
                              rel="noreferrer"
                              className="font-medium underline"
                            >
                              {evidence.sourceTitle}
                            </a>
                          ) : (
                            evidence.sourceTitle
                          )}
                          {evidence.pageStart
                            ? ` · page ${evidence.pageStart}`
                            : evidence.section
                              ? ` · ${evidence.section}`
                              : ""}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
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
          {quiz.evidenceAvailable && (
            <div className="mt-3 text-xs text-muted">
              {quiz.generation.readyCount} of {quiz.generation.targetCount} verified
              questions ready
              {batchLoading ? " · preparing more…" : ""}
            </div>
          )}
        </div>

        {playError && (
          <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{playError}</p>
        )}
        {batchError && (
          <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
            {batchError}
          </p>
        )}
        {quiz.evidenceAvailable &&
          quiz.generation.failedBatchCount > 0 &&
          !quiz.generation.hasMore && (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm" style={{ borderColor: "var(--border)" }}>
              <span>
                Some requested questions could not be verified. You can finish
                this partial quiz or retry them.
              </span>
              <button
                onClick={() => requestMoreBatches(true)}
                disabled={batchLoading}
                className="btn-ghost shrink-0"
              >
                Retry missing
              </button>
            </div>
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
              {checkResult.optionExplanations && (
                <div className="space-y-1.5">
                  {q.options.map((option) => (
                    <div
                      key={`why-${option.id}`}
                      className="rounded-lg px-3 py-2 text-xs leading-relaxed"
                      style={{ backgroundColor: "var(--surface-sunk)" }}
                    >
                      <span className="mr-1 font-semibold">{option.id}.</span>
                      {checkResult.optionExplanations?.[option.id]}
                    </div>
                  ))}
                </div>
              )}
              {checkResult.evidence.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Supporting evidence
                  </p>
                  {checkResult.evidence.map((evidence, evidenceIndex) => (
                    <div
                      key={`${q.id}-support-${evidenceIndex}`}
                      className="rounded-lg border px-3 py-2 text-xs leading-relaxed"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <p>&ldquo;{evidence.quote}&rdquo;</p>
                      <p className="mt-1 text-muted">
                        {evidence.url ? (
                          <a
                            href={evidence.url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium underline"
                          >
                            {evidence.sourceTitle}
                          </a>
                        ) : (
                          evidence.sourceTitle
                        )}
                        {evidence.pageStart
                          ? ` · page ${evidence.pageStart}`
                          : evidence.section
                            ? ` · ${evidence.section}`
                            : ""}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              <button onClick={handleNext} disabled={submitting} className="btn-primary w-full">
                {submitting
                  ? "Saving…"
                  : currentIdx + 1 === quiz.questions.length &&
                      quiz.evidenceAvailable &&
                      quiz.generation.hasMore
                    ? batchLoading
                      ? "Preparing more verified questions…"
                      : "Prepare more verified questions"
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
