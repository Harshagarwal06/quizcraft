import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";

export async function GET() {
  try {
    return await buildDashboard();
  } catch (err) {
    console.error("[dashboard] failed:", err);
    return NextResponse.json(
      { overallAccuracy: 0, totalAttempts: 0, totalAnswered: 0, accuracyOverTime: [], byDifficulty: [], byTopic: [] },
      { status: 200 }
    );
  }
}

// SQLite aggregates come back as bigint via the driver adapter; normalize.
type GroupRow = { label: string; total: bigint | number; correct: bigint | number };
type TotalsRow = { totalAnswered: bigint | number; totalCorrect: bigint | number };
const n = (v: bigint | number | null) => Number(v ?? 0);
const pct = (correct: number, total: number) =>
  total > 0 ? Math.round((correct / total) * 100) : 0;

async function buildDashboard() {
  const userId = await getCurrentUserId();

  // Aggregate in the database (GROUP BY over a JOIN) instead of pulling every
  // answer record into memory — the result set stays tiny as the data grows.
  const [attempts, byDifficultyRows, byTopicRows, totalsRows] = await Promise.all([
    prisma.attempt.findMany({
      where: { userId, completedAt: { not: null } },
      orderBy: { startedAt: "asc" },
      select: {
        score: true,
        totalQuestions: true,
        startedAt: true,
        quiz: { select: { title: true } },
      },
    }),
    prisma.$queryRaw<GroupRow[]>`
      SELECT q."difficulty" AS label,
             COUNT(*) AS total,
             SUM(CASE WHEN ar."isCorrect" THEN 1 ELSE 0 END) AS correct
      FROM "AnswerRecord" ar
      JOIN "Question" q ON q."id" = ar."questionId"
      JOIN "Attempt" a ON a."id" = ar."attemptId"
      WHERE a."userId" = ${userId}
      GROUP BY q."difficulty"`,
    prisma.$queryRaw<GroupRow[]>`
      SELECT q."topic" AS label,
             COUNT(*) AS total,
             SUM(CASE WHEN ar."isCorrect" THEN 1 ELSE 0 END) AS correct
      FROM "AnswerRecord" ar
      JOIN "Question" q ON q."id" = ar."questionId"
      JOIN "Attempt" a ON a."id" = ar."attemptId"
      WHERE a."userId" = ${userId}
      GROUP BY q."topic"
      ORDER BY total DESC
      LIMIT 10`,
    prisma.$queryRaw<TotalsRow[]>`
      SELECT COUNT(*) AS totalAnswered,
             SUM(CASE WHEN ar."isCorrect" THEN 1 ELSE 0 END) AS totalCorrect
      FROM "AnswerRecord" ar
      JOIN "Attempt" a ON a."id" = ar."attemptId"
      WHERE a."userId" = ${userId}`,
  ]);

  // Accuracy over time (one point per attempt)
  const accuracyOverTime = attempts.map((a) => ({
    date: a.startedAt.toISOString().slice(0, 10),
    accuracy: pct(a.score ?? 0, a.totalQuestions),
    quizTitle: a.quiz?.title ?? "Untitled quiz",
  }));

  const byDifficulty = byDifficultyRows.map((r) => ({
    difficulty: r.label,
    accuracy: pct(n(r.correct), n(r.total)),
    total: n(r.total),
  }));

  const byTopic = byTopicRows.map((r) => ({
    topic: r.label,
    accuracy: pct(n(r.correct), n(r.total)),
    total: n(r.total),
  }));

  // Summary stats
  const totalAnswered = n(totalsRows[0]?.totalAnswered);
  const totalCorrect = n(totalsRows[0]?.totalCorrect);

  return NextResponse.json({
    overallAccuracy: pct(totalCorrect, totalAnswered),
    totalAttempts: attempts.length,
    totalAnswered,
    accuracyOverTime,
    byDifficulty,
    byTopic,
  });
}
