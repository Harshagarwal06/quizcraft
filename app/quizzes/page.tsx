import Link from "next/link";
import NavBar from "@/app/components/NavBar";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { redirect } from "next/navigation";

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

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function QuizzesPage() {
  const userId = await getCurrentUserId();
  if (!userId) {
    redirect("/api/auth/signin");
  }

  const quizzes = await prisma.quiz.findMany({
    where: {
      userId,
      purpose: "standard",
      OR: [{ generationStatus: "legacy" }, { questionCount: { gt: 0 } }],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      sourceType: true,
      questionCount: true,
      createdAt: true,
      _count: { select: { attempts: true } },
    },
  });

  return (
    <>
      <NavBar />
      <div className="mx-auto max-w-3xl px-4 py-10">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-jakarta)' }}>My Quizzes</h1>
            <p className="mt-1 text-muted">All quizzes you&apos;ve generated</p>
          </div>
          <Link href="/generate" className="btn-primary">
            + New quiz
          </Link>
        </div>

        {quizzes.length === 0 ? (
          <div className="glass-card p-12 text-center">
            <div
              className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl text-white"
              style={{ backgroundImage: "linear-gradient(135deg, #a78bfa, #818cf8)" }}
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
              <div key={q.id} className="glass-card flex items-center justify-between gap-4 p-5">
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
                <Link
                  href={`/quiz/${q.id}`}
                  className="btn-ghost shrink-0 text-sm"
                >
                  Play again
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
