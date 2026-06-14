"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
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
};

const difficultyColor: Record<string, string> = {
  easy: "#10b981",
  medium: "#f59e0b",
  hard: "#ef4444",
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      });
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
      </div>
    </>
  );
}
