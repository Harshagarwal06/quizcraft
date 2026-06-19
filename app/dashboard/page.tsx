"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import NavBar from "@/app/components/NavBar";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
} from "recharts";

type DashboardData = {
  overallAccuracy: number;
  totalAttempts: number;
  totalAnswered: number;
  accuracyOverTime: { date: string; accuracy: number; quizTitle: string }[];
  byDifficulty: { difficulty: string; accuracy: number; total: number }[];
  byTopic: { topic: string; accuracy: number; total: number }[];
  mastery: {
    dueCount: number;
    activeCount: number;
    masteredCount: number;
    reviewGroups: {
      sourceQuizId: string;
      quizTitle: string;
      concepts: {
        conceptKey: string;
        label: string;
        stage: number;
        dueAt: string | null;
      }[];
    }[];
  };
};

type QualityData = {
  quizzesVerified: number;
  questionsChecked: number;
  initialErrorRate: number;
  repairRate: number;
  removalRate: number;
  verdictDistribution: { pass: number; repaired: number; flagged: number; unverified: number };
  byVerifierModel: { model: string; checked: number; repaired: number; flagged: number }[];
  qualityOverTime: { date: string; checked: number; caught: number }[];
};

// Verdict palette — verified (emerald) / repaired (indigo) / removed (rose)
const verdictColor: Record<string, string> = {
  pass: "#10b981",
  repaired: "#6366f1",
  flagged: "#f43f5e",
};

// Difficulty palette — emerald / amber / rose (design system semantic colors)
const difficultyColor: Record<string, string> = {
  easy: "#10b981",
  medium: "#f59e0b",
  hard: "#f43f5e",
};

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [quality, setQuality] = useState<QualityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewLoadingId, setReviewLoadingId] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setData(d))
      .catch(() =>
        setData({
          overallAccuracy: 0,
          totalAttempts: 0,
          totalAnswered: 0,
          accuracyOverTime: [],
          byDifficulty: [],
          byTopic: [],
          mastery: {
            dueCount: 0,
            activeCount: 0,
            masteredCount: 0,
            reviewGroups: [],
          },
        })
      )
      .finally(() => setLoading(false));

    // Quality Engine stats load independently of attempt data.
    fetch("/api/quality")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((q) => setQuality(q))
      .catch(() => setQuality(null));
  }, []);

  if (loading) {
    return (
      <>
        <NavBar />
        <div className="flex min-h-[60vh] items-center justify-center">
          <p className="animate-pulse text-muted">Loading dashboard…</p>
        </div>
      </>
    );
  }

  if (!data) return null;

  const hasData = data.totalAttempts > 0;

  async function startReview(sourceQuizId: string) {
    if (reviewLoadingId) return;
    setReviewLoadingId(sourceQuizId);
    setReviewError(null);
    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceQuizId }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error ?? "Couldn't prepare the review.");
      }
      router.push(`/quiz/${result.id}`);
    } catch (error) {
      setReviewError(
        error instanceof Error ? error.message : "Couldn't prepare the review."
      );
      setReviewLoadingId(null);
    }
  }

  return (
    <>
      <NavBar />
      <div className="mx-auto max-w-5xl px-4 py-10">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
            <p className="mt-1 text-muted">Track your learning progress</p>
          </div>
          <Link href="/generate" className="btn-primary">
            + New quiz
          </Link>
        </div>

        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[
            {
              label: "Due now",
              value: data.mastery.dueCount,
              color: data.mastery.dueCount > 0 ? "#f43f5e" : "var(--foreground)",
            },
            {
              label: "Active concepts",
              value: data.mastery.activeCount,
              color: "var(--primary)",
            },
            {
              label: "Mastered",
              value: data.mastery.masteredCount,
              color: "#10b981",
            },
          ].map((card) => (
            <div key={card.label} className="card p-5">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
                {card.label}
              </p>
              <p className="text-3xl font-bold" style={{ color: card.color }}>
                {card.value}
              </p>
            </div>
          ))}
        </div>

        {data.mastery.reviewGroups.length > 0 && (
          <section className="mb-8">
            <div className="mb-4">
              <h2 className="text-lg font-bold tracking-tight">Ready to review</h2>
              <p className="mt-1 text-sm text-muted">
                Fresh verified questions for your weakest due concepts.
              </p>
            </div>
            {reviewError && (
              <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
                {reviewError}
              </p>
            )}
            <div className="space-y-3">
              {data.mastery.reviewGroups.map((group) => (
                <div
                  key={group.sourceQuizId}
                  className="card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <h3 className="font-semibold">{group.quizTitle}</h3>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {group.concepts.slice(0, 3).map((concept) => (
                        <span
                          key={concept.conceptKey}
                          className="rounded-full px-2.5 py-1 text-xs font-medium"
                          style={{
                            backgroundColor: "var(--primary-soft)",
                            color: "var(--primary)",
                          }}
                        >
                          {concept.label} · stage {concept.stage}
                        </span>
                      ))}
                      {group.concepts.length > 3 && (
                        <span className="rounded-full px-2.5 py-1 text-xs text-muted">
                          +{group.concepts.length - 3} more
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => startReview(group.sourceQuizId)}
                    disabled={Boolean(reviewLoadingId)}
                    className="btn-primary shrink-0"
                  >
                    {reviewLoadingId === group.sourceQuizId
                      ? "Preparing…"
                      : `Review ${Math.min(group.concepts.length, 3)} concepts`}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Summary cards */}
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[
            { label: "Overall accuracy", value: `${data.overallAccuracy}%`, accent: true },
            { label: "Quizzes taken", value: String(data.totalAttempts), accent: false },
            { label: "Questions answered", value: String(data.totalAnswered), accent: false },
          ].map((card) => (
            <div key={card.label} className="card p-5">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{card.label}</p>
              <p
                className="text-3xl font-bold"
                style={card.accent ? { color: "var(--primary)" } : { color: "var(--foreground)" }}
              >
                {card.value}
              </p>
            </div>
          ))}
        </div>

        {!hasData ? (
          <div className="card p-12 text-center">
            <div
              className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl text-white"
              style={{ backgroundImage: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
            >
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />
              </svg>
            </div>
            <p className="mb-4 text-muted">No quiz attempts yet.</p>
            <Link href="/generate" className="btn-primary">
              Generate your first quiz
            </Link>
          </div>
        ) : (
          <div className="space-y-6">
            {data.accuracyOverTime.length > 1 && (
              <div className="card p-6">
                <h2 className="mb-4 text-sm font-semibold">Accuracy over time</h2>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={data.accuracyOverTime}>
                    <defs>
                      <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#6366f1" />
                        <stop offset="100%" stopColor="#8b5cf6" />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--muted)" }} stroke="var(--border)" />
                    <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: "var(--muted)" }} stroke="var(--border)" />
                    <Tooltip
                      formatter={(value) => [`${value}%`, "Accuracy"]}
                      labelFormatter={(_, payload) => payload?.[0]?.payload?.quizTitle ?? ""}
                      contentStyle={{ borderRadius: 12, border: "1px solid var(--border)", background: "var(--surface)", fontSize: 12 }}
                    />
                    <Line type="monotone" dataKey="accuracy" stroke="url(#lineGrad)" strokeWidth={3} dot={{ r: 4, fill: "#6366f1" }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {data.byDifficulty.length > 0 && (
              <div className="card p-6">
                <h2 className="mb-4 text-sm font-semibold">Accuracy by difficulty</h2>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={data.byDifficulty} barCategoryGap="30%">
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="difficulty" tick={{ fontSize: 12, fill: "var(--muted)" }} stroke="var(--border)" />
                    <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: "var(--muted)" }} stroke="var(--border)" />
                    <Tooltip
                      formatter={(v) => [`${v}%`, "Accuracy"]}
                      contentStyle={{ borderRadius: 12, border: "1px solid var(--border)", background: "var(--surface)", fontSize: 12 }}
                      cursor={{ fill: "color-mix(in srgb, var(--foreground) 5%, transparent)" }}
                    />
                    <Bar dataKey="accuracy" radius={[6, 6, 0, 0]}>
                      {data.byDifficulty.map((entry) => (
                        <Cell key={entry.difficulty} fill={difficultyColor[entry.difficulty] ?? "#94a3b8"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {data.byTopic.length > 0 && (
              <div className="card p-6">
                <h2 className="mb-4 text-sm font-semibold">Top topics</h2>
                <div className="space-y-3">
                  {data.byTopic.map((t) => (
                    <div key={t.topic} className="flex items-center gap-3">
                      <span className="w-32 shrink-0 truncate text-xs text-muted">{t.topic}</span>
                      <div className="h-2.5 flex-1 overflow-hidden rounded-full" style={{ backgroundColor: "var(--border)" }}>
                        <div
                          className="h-2.5 rounded-full transition-all"
                          style={{ width: `${t.accuracy}%`, backgroundImage: "linear-gradient(90deg, #6366f1, #8b5cf6)" }}
                        />
                      </div>
                      <span className="w-10 text-right text-xs font-medium">{t.accuracy}%</span>
                      <span className="w-12 text-right text-xs text-muted">{t.total} q</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {quality && quality.quizzesVerified > 0 && (
          <div className="mt-10">
            <div className="mb-4 flex items-center gap-2">
              <h2 className="text-lg font-bold tracking-tight">Quality Engine</h2>
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                {quality.quizzesVerified} {quality.quizzesVerified === 1 ? "quiz" : "quizzes"} verified
              </span>
            </div>
            <p className="mb-5 text-sm text-muted">
              An independent verifier audits every generated question against its source. These are
              its findings across {quality.questionsChecked} checked questions.
            </p>

            <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
              {[
                { label: "Errors caught (initial)", value: `${quality.initialErrorRate}%`, color: "#f43f5e" },
                { label: "Auto-repaired", value: `${quality.repairRate}%`, color: "#6366f1" },
                { label: "Removed (flagged)", value: `${quality.removalRate}%`, color: "#f59e0b" },
              ].map((card) => (
                <div key={card.label} className="card p-5">
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{card.label}</p>
                  <p className="text-3xl font-bold" style={{ color: card.color }}>{card.value}</p>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="card p-6">
                <h3 className="mb-4 text-sm font-semibold">Question verdicts</h3>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart
                    data={[
                      { name: "Verified", key: "pass", value: quality.verdictDistribution.pass },
                      { name: "Repaired", key: "repaired", value: quality.verdictDistribution.repaired },
                      { name: "Removed", key: "flagged", value: quality.verdictDistribution.flagged },
                    ]}
                    barCategoryGap="30%"
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="name" tick={{ fontSize: 12, fill: "var(--muted)" }} stroke="var(--border)" />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--muted)" }} stroke="var(--border)" />
                    <Tooltip
                      formatter={(v) => [`${v} questions`, "Count"]}
                      contentStyle={{ borderRadius: 12, border: "1px solid var(--border)", background: "var(--surface)", fontSize: 12 }}
                      cursor={{ fill: "color-mix(in srgb, var(--foreground) 5%, transparent)" }}
                    />
                    <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                      {["pass", "repaired", "flagged"].map((k) => (
                        <Cell key={k} fill={verdictColor[k]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {quality.qualityOverTime.length > 1 && (
                <div className="card p-6">
                  <h3 className="mb-4 text-sm font-semibold">Errors caught over time</h3>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={quality.qualityOverTime}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--muted)" }} stroke="var(--border)" />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--muted)" }} stroke="var(--border)" />
                      <Tooltip
                        formatter={(v) => [`${v} caught`, "Errors"]}
                        contentStyle={{ borderRadius: 12, border: "1px solid var(--border)", background: "var(--surface)", fontSize: 12 }}
                      />
                      <Line type="monotone" dataKey="caught" stroke="#f43f5e" strokeWidth={3} dot={{ r: 4, fill: "#f43f5e" }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {quality.byVerifierModel.length > 0 && (
              <div className="card mt-6 p-6">
                <h3 className="mb-4 text-sm font-semibold">By verifier model</h3>
                <div className="space-y-2">
                  {quality.byVerifierModel.map((m) => (
                    <div key={m.model} className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate font-mono text-xs text-muted">{m.model}</span>
                      <span className="shrink-0 text-xs text-muted">
                        {m.checked} checked · <span className="text-indigo-600">{m.repaired} repaired</span> ·{" "}
                        <span className="text-rose-600">{m.flagged} removed</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
