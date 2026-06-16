import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getCurrentUserId();

  const { id } = await params;
  const quiz = await prisma.quiz.findUnique({
    where: { id },
    include: {
      questions: {
        orderBy: { order: "asc" },
        select: {
          id: true,
          stem: true,
          options: true,
          difficulty: true,
          topic: true,
          order: true,
          verdict: true,
          // correctOption, explanation and verificationDetail are intentionally
          // excluded — verificationDetail would reveal the correct answer.
        },
      },
    },
  });

  if (!quiz || quiz.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Once verified, never serve a known-bad ("flagged") question to the learner.
  const playable = quiz.questions.filter((q) => q.verdict !== "flagged");

  let summary: unknown = null;
  if (quiz.verificationSummary) {
    try {
      summary = JSON.parse(quiz.verificationSummary);
    } catch {
      summary = null;
    }
  }

  return NextResponse.json({
    id: quiz.id,
    title: quiz.title,
    questionCount: playable.length,
    verificationStatus: quiz.verificationStatus,
    verifierModel: quiz.verifierModel,
    verificationSummary: summary,
    questions: playable.map((q) => ({
      id: q.id,
      stem: q.stem,
      difficulty: q.difficulty,
      topic: q.topic,
      order: q.order,
      // Only the trust-badge label leaves the server, never the reasons.
      verdict: q.verdict, // null (unverified) | "pass" | "repaired"
      options: JSON.parse(q.options),
    })),
  });
}
