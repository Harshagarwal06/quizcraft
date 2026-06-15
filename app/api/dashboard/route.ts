import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";

export async function GET() {
  const userId = await getCurrentUserId();

  const [attempts, answerRecords] = await Promise.all([
    prisma.attempt.findMany({
      where: { userId, completedAt: { not: null } },
      orderBy: { startedAt: "asc" },
      select: {
        id: true,
        score: true,
        totalQuestions: true,
        startedAt: true,
        quiz: { select: { title: true } },
      },
    }),
    prisma.answerRecord.findMany({
      where: { attempt: { userId } },
      select: {
        isCorrect: true,
        question: { select: { difficulty: true, topic: true } },
      },
    }),
  ]);

  // Accuracy over time (one point per attempt)
  const accuracyOverTime = attempts.map((a) => ({
    date: a.startedAt.toISOString().slice(0, 10),
    accuracy: a.totalQuestions > 0 ? Math.round(((a.score ?? 0) / a.totalQuestions) * 100) : 0,
    quizTitle: a.quiz.title,
  }));

  // Per-difficulty breakdown
  const difficultyMap: Record<string, { correct: number; total: number }> = {};
  for (const r of answerRecords) {
    const d = r.question.difficulty;
    if (!difficultyMap[d]) difficultyMap[d] = { correct: 0, total: 0 };
    difficultyMap[d].total++;
    if (r.isCorrect) difficultyMap[d].correct++;
  }
  const byDifficulty = Object.entries(difficultyMap).map(([difficulty, v]) => ({
    difficulty,
    accuracy: Math.round((v.correct / v.total) * 100),
    total: v.total,
  }));

  // Per-topic breakdown (top 10)
  const topicMap: Record<string, { correct: number; total: number }> = {};
  for (const r of answerRecords) {
    const t = r.question.topic;
    if (!topicMap[t]) topicMap[t] = { correct: 0, total: 0 };
    topicMap[t].total++;
    if (r.isCorrect) topicMap[t].correct++;
  }
  const byTopic = Object.entries(topicMap)
    .map(([topic, v]) => ({
      topic,
      accuracy: Math.round((v.correct / v.total) * 100),
      total: v.total,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  // Summary stats
  const totalAttempts = attempts.length;
  const totalAnswered = answerRecords.length;
  const totalCorrect = answerRecords.filter((r) => r.isCorrect).length;
  const overallAccuracy =
    totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0;

  return NextResponse.json({
    overallAccuracy,
    totalAttempts,
    totalAnswered,
    accuracyOverTime,
    byDifficulty,
    byTopic,
  });
}
