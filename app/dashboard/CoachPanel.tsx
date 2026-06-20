"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type CoachAction = {
  id: string;
  type: "lesson" | "quiz" | "review" | "request_source" | "rest";
  status: string;
  title: string;
  reason: string;
  estimatedMinutes: number;
  requiresConfirmation: boolean;
  conceptKeys: string[];
  readyHref: string | null;
  error: string | null;
};

type CoachMessage = {
  id: string;
  role: string;
  content: string;
  citations: {
    quote: string;
    sourceTitle: string;
    pageStart: number | null;
    section: string | null;
    url: string | null;
  }[];
  pendingPlanUpdate: { examDate?: string } | null;
  proposedActionId: string | null;
  createdAt: string;
};

export type CoachSnapshot = {
  enabled: boolean;
  plan: {
    id: string;
    examTitle: string;
    examDate: string;
    targetScore: number;
    dailyMinutes: number;
    availableDays: number[];
    stateVersion: number;
    sources: { id: string; title: string; kind: string }[];
    conceptCount: number;
  } | null;
  availableSources: {
    id: string;
    title: string;
    kind: string;
    quizId: string | null;
    quizTitle: string;
  }[];
  recommendation: CoachAction | null;
  messages: CoachMessage[];
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function CoachPanel({
  initial,
}: {
  initial: CoachSnapshot;
}) {
  const router = useRouter();
  const [coach, setCoach] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessage, setChatMessage] = useState("");
  const [examTitle, setExamTitle] = useState("");
  const [examDate, setExamDate] = useState("");
  const [targetScore, setTargetScore] = useState(80);
  const [dailyMinutes, setDailyMinutes] = useState(45);
  const [availableDays, setAvailableDays] = useState([1, 2, 3, 4, 5]);
  const [sourceIds, setSourceIds] = useState<string[]>(
    initial.availableSources[0] ? [initial.availableSources[0].id] : []
  );

  if (!coach.enabled) return null;

  async function refreshSnapshot() {
    const response = await fetch("/api/coach");
    if (response.ok) setCoach(await response.json());
  }

  async function createPlan(event: FormEvent) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/coach/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          examTitle,
          examDate: new Date(`${examDate}T12:00:00`).toISOString(),
          targetScore,
          dailyMinutes,
          availableDays,
          sourceDocumentIds: sourceIds,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error ?? "Couldn't create the plan.");
      setCoach(data);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Couldn't create the plan."
      );
    } finally {
      setLoading(false);
    }
  }

  async function confirmAction(action: CoachAction) {
    if (loading) return;
    if (action.readyHref) {
      router.push(action.readyHref);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/coach/actions/${action.id}/confirm`,
        { method: "POST" }
      );
      const data = await response.json().catch(() => null);
      if (!response.ok && response.status !== 202) {
        throw new Error(
          data?.action?.error ?? data?.error ?? "Couldn't prepare the activity."
        );
      }
      if (data?.action?.readyHref) {
        router.push(data.action.readyHref);
      } else {
        await refreshSnapshot();
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Couldn't prepare the activity."
      );
      await refreshSnapshot();
    } finally {
      setLoading(false);
    }
  }

  async function dismissAction(actionId: string) {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/coach/actions/${actionId}/dismiss`, {
        method: "POST",
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error ?? "Couldn't dismiss it.");
      setCoach(data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't dismiss it.");
    } finally {
      setLoading(false);
    }
  }

  async function refreshRecommendation() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/coach/refresh", { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error ?? "Couldn't refresh your coach.");
      }
      setCoach(data);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Couldn't refresh your coach."
      );
    } finally {
      setLoading(false);
    }
  }

  async function sendChat(event: FormEvent) {
    event.preventDefault();
    const message = chatMessage.trim();
    if (!message || loading) return;
    setLoading(true);
    setError(null);
    setChatMessage("");
    try {
      const response = await fetch("/api/coach/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error ?? "Coach couldn't respond.");
      await refreshSnapshot();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Coach couldn't respond."
      );
    } finally {
      setLoading(false);
    }
  }

  async function confirmPlanUpdate(update: { examDate?: string }) {
    if (!coach.plan || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/coach/plans/${coach.plan.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, changes: update }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error ?? "Couldn't update the plan.");
      setCoach(data);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Couldn't update the plan."
      );
    } finally {
      setLoading(false);
    }
  }

  if (!coach.plan) {
    return (
      <section className="glass-card mb-8 overflow-hidden">
        <div
          className="px-6 py-5 text-white"
          style={{ backgroundImage: "var(--brand-gradient)" }}
        >
          <p className="text-xs font-semibold uppercase tracking-widest text-white/75">
            Study Coach Agent
          </p>
          <h2 className="mt-1 text-2xl font-bold">Build your exam plan</h2>
          <p className="mt-1 text-sm text-white/85">
            Your coach will propose cited lessons, quizzes, and due reviews—but
            will always ask before generating them.
          </p>
        </div>
        {coach.availableSources.length === 0 ? (
          <div className="p-6">
            <p className="text-sm text-muted">
              Generate an evidence-backed quiz first so your coach has source
              material to work from.
            </p>
            <Link href="/generate" className="btn-primary mt-4">
              Add study material
            </Link>
          </div>
        ) : (
          <form onSubmit={createPlan} className="space-y-5 p-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <label>
                <span className="label">Exam or goal</span>
                <input
                  className="field"
                  value={examTitle}
                  onChange={(event) => setExamTitle(event.target.value)}
                  placeholder="e.g. Biology midterm"
                  required
                />
              </label>
              <label>
                <span className="label">Exam date</span>
                <input
                  type="date"
                  className="field"
                  value={examDate}
                  onChange={(event) => setExamDate(event.target.value)}
                  required
                />
              </label>
              <label>
                <span className="label">Target score (%)</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  className="field"
                  value={targetScore}
                  onChange={(event) => setTargetScore(Number(event.target.value))}
                  required
                />
              </label>
              <label>
                <span className="label">Minutes per study day</span>
                <input
                  type="number"
                  min={10}
                  max={240}
                  className="field"
                  value={dailyMinutes}
                  onChange={(event) => setDailyMinutes(Number(event.target.value))}
                  required
                />
              </label>
            </div>

            <div>
              <span className="label">Available days</span>
              <div className="flex flex-wrap gap-2">
                {WEEKDAYS.map((day, index) => {
                  const active = availableDays.includes(index);
                  return (
                    <button
                      type="button"
                      key={day}
                      onClick={() =>
                        setAvailableDays((current) =>
                          active
                            ? current.filter((value) => value !== index)
                            : [...current, index]
                        )
                      }
                      className="rounded-lg border px-3 py-2 text-xs font-medium"
                      style={{
                        borderColor: active ? "var(--primary)" : "var(--border)",
                        backgroundColor: active
                          ? "var(--primary-soft)"
                          : "var(--surface)",
                        color: active ? "var(--primary)" : "var(--muted)",
                      }}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <span className="label">Study sources</span>
              <div className="space-y-2">
                {coach.availableSources.map((source) => (
                  <label
                    key={source.id}
                    className="flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <input
                      type="checkbox"
                      checked={sourceIds.includes(source.id)}
                      onChange={(event) =>
                        setSourceIds((current) =>
                          event.target.checked
                            ? [...current, source.id]
                            : current.filter((id) => id !== source.id)
                        )
                      }
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {source.quizTitle}
                      </span>
                      <span className="text-xs text-muted">
                        {source.kind.toUpperCase()} · {source.title}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="btn-primary"
              disabled={
                loading ||
                !examTitle.trim() ||
                !examDate ||
                availableDays.length === 0 ||
                sourceIds.length === 0
              }
            >
              {loading ? "Building plan…" : "Create study plan"}
            </button>
          </form>
        )}
      </section>
    );
  }

  const action = coach.recommendation;
  return (
    <section className="mb-8 space-y-4">
      <div className="glass-card overflow-hidden">
        <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">
              Your coach recommends
            </p>
            <h2 className="mt-1 text-xl font-bold">
              {action?.title ?? "Ready for your next move"}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
              {action?.reason ??
                "Refresh the coach when you want a new recommendation."}
            </p>
            <p className="mt-3 text-xs text-muted">
              {coach.plan.examTitle} · target {coach.plan.targetScore}% ·{" "}
              {coach.plan.dailyMinutes} min/day
              {action ? ` · about ${action.estimatedMinutes} min` : ""}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {action ? (
              <>
                <button
                  type="button"
                  onClick={() => confirmAction(action)}
                  disabled={loading || action.status === "preparing"}
                  className="btn-primary"
                >
                  {loading || action.status === "preparing"
                    ? "Preparing…"
                    : action.readyHref
                      ? "Open activity"
                      : action.status === "failed"
                        ? "Retry"
                        : "Confirm"}
                </button>
                {action.requiresConfirmation && (
                  <button
                    type="button"
                    onClick={() => dismissAction(action.id)}
                    disabled={loading}
                    className="btn-ghost"
                  >
                    Dismiss
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={refreshRecommendation}
                disabled={loading}
                className="btn-primary"
              >
                {loading ? "Thinking…" : "Refresh coach"}
              </button>
            )}
          </div>
        </div>
        {action?.error && (
          <p className="border-t bg-red-50 px-6 py-3 text-sm text-red-600">
            {action.error}
          </p>
        )}
        {error && (
          <p className="border-t bg-red-50 px-6 py-3 text-sm text-red-600">
            {error}
          </p>
        )}
      </div>

      <div className="glass-card">
        <button
          type="button"
          onClick={() => setChatOpen((open) => !open)}
          className="flex w-full items-center justify-between px-5 py-4 text-left"
        >
          <span>
            <span className="block text-sm font-semibold">Ask your coach</span>
            <span className="text-xs text-muted">
              Source-grounded answers and plan adjustments
            </span>
          </span>
          <span className="text-muted">{chatOpen ? "−" : "+"}</span>
        </button>
        {chatOpen && (
          <div className="border-t px-5 py-4" style={{ borderColor: "var(--border)" }}>
            <div className="max-h-80 space-y-3 overflow-y-auto">
              {coach.messages.length === 0 && (
                <p className="text-sm text-muted">
                  Ask about your sources, progress, schedule, or request a
                  lesson or quiz.
                </p>
              )}
              {coach.messages.map((message) => (
                <div
                  key={message.id}
                  className={`rounded-xl px-4 py-3 text-sm ${
                    message.role === "user" ? "ml-8" : "mr-8"
                  }`}
                  style={{
                    backgroundColor:
                      message.role === "user"
                        ? "var(--primary-soft)"
                        : "var(--surface-sunk)",
                  }}
                >
                  <p className="whitespace-pre-line leading-6">{message.content}</p>
                  {message.citations.map((citation, index) => (
                    <div
                      key={`${message.id}-${index}`}
                      className="mt-2 border-t pt-2 text-xs text-muted"
                      style={{ borderColor: "var(--border)" }}
                    >
                      &ldquo;{citation.quote}&rdquo; —{" "}
                      {citation.url ? (
                        <a
                          href={citation.url}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          {citation.sourceTitle}
                        </a>
                      ) : (
                        citation.sourceTitle
                      )}
                    </div>
                  ))}
                  {message.pendingPlanUpdate?.examDate && (
                    <button
                      type="button"
                      className="btn-primary mt-3"
                      disabled={loading}
                      onClick={() =>
                        confirmPlanUpdate(message.pendingPlanUpdate!)
                      }
                    >
                      Confirm plan change
                    </button>
                  )}
                </div>
              ))}
            </div>
            <form onSubmit={sendChat} className="mt-4 flex gap-2">
              <input
                className="field"
                value={chatMessage}
                onChange={(event) => setChatMessage(event.target.value)}
                placeholder="Ask from your sources or adjust your plan…"
                disabled={loading}
              />
              <button
                type="submit"
                className="btn-primary shrink-0"
                disabled={loading || !chatMessage.trim()}
              >
                Send
              </button>
            </form>
          </div>
        )}
      </div>
    </section>
  );
}
