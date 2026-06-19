"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import NavBar from "@/app/components/NavBar";

type QuizSummary = {
  id: string;
  title: string;
  sourceType: string;
  questionCount: number;
  createdAt: string;
  _count: { attempts: number };
};

const sourceTypeLabel: Record<string, string> = {
  pdf: "PDF",
  notes: "Notes",
  prompt: "Prompt",
};

const sourceTypeColor: Record<string, string> = {
  pdf: "bg-rose-100 text-rose-700",
  notes: "bg-sky-100 text-sky-700",
  prompt: "bg-violet-100 text-violet-700",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function QuizzesPage() {
  const router = useRouter();
  const [quizzes, setQuizzes] = useState<QuizSummary[] | null>(null);

  useEffect(() => {
    fetch("/api/quizzes")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setQuizzes)
      .catch(() => setQuizzes([]));
  }, []);

  return (
    <>
      <NavBar />
      <div className="mx-auto max-w-3xl px-4 py-10">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">My Quizzes</h1>
            <p className="mt-1 text-muted">All quizzes you&apos;ve generated</p>
          </div>
          <Link href="/generate" className="btn-primary">
            + New quiz
          </Link>
        </div>

        {quizzes === null ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="card animate-pulse p-5">
                <div className="mb-2 h-4 w-2/3 rounded" style={{ backgroundColor: "var(--border)" }} />
                <div className="h-3 w-1/3 rounded" style={{ backgroundColor: "var(--border)" }} />
              </div>
            ))}
          </div>
        ) : quizzes.length === 0 ? (
          <div className="card p-12 text-center">
            <div
              className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl text-white"
              style={{ backgroundImage: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
            >
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            </div>
            <p className="mb-4 text-muted">No quizzes yet.</p>
            <Link href="/generate" className="btn-primary">
              Generate your first quiz
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {quizzes.map((q) => (
              <div key={q.id} className="card flex items-center justify-between gap-4 p-5">
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${sourceTypeColor[q.sourceType] ?? "bg-slate-100 text-slate-600"}`}
                    >
                      {sourceTypeLabel[q.sourceType] ?? q.sourceType}
                    </span>
                    <h2 className="truncate text-sm font-semibold leading-snug">{q.title}</h2>
                  </div>
                  <p className="text-xs text-muted">
                    {q.questionCount} questions · {q._count.attempts}{" "}
                    {q._count.attempts === 1 ? "attempt" : "attempts"} · {formatDate(q.createdAt)}
                  </p>
                </div>
                <button
                  onClick={() => router.push(`/quiz/${q.id}`)}
                  className="btn-ghost shrink-0 text-sm"
                >
                  Play again
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
