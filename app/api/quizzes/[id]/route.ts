import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { playableReviewQuestions } from "@/lib/mastery";

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
          reviewConceptKey: true,
          evidenceStatus: true,
          // correctOption, explanation and verificationDetail are intentionally
          // excluded — verificationDetail would reveal the correct answer.
        },
      },
      generationBatches: {
        select: { status: true },
      },
    },
  });

  if (!quiz || quiz.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const isReview = quiz.purpose === "review";
  const evidenceAvailable = Boolean(quiz.sourceDocumentId);
  const reviewPlayable =
    isReview && quiz.verificationStatus === "verified"
      ? playableReviewQuestions(quiz.questions)
      : [];
  // Standard quizzes can begin before verification settles. Reviews are stricter:
  // only complete two-question concept pairs with pass/repaired verdicts leave.
  const playable = isReview
    ? reviewPlayable
    : quiz.questions.filter((q) =>
        evidenceAvailable
          ? (q.verdict === "pass" || q.verdict === "repaired") &&
            q.evidenceStatus === "valid"
          : q.verdict !== "flagged" && q.verdict !== "unverified"
      );
  const pendingBatchCount = quiz.generationBatches.filter((batch) =>
    ["pending", "generating", "verifying"].includes(batch.status)
  ).length;
  const failedBatchCount = quiz.generationBatches.filter(
    (batch) => batch.status === "failed"
  ).length;

  const reviewReadiness = !isReview
    ? null
    : quiz.verificationStatus === "pending" ||
        quiz.verificationStatus === "verifying"
      ? { status: "preparing", reason: null }
      : quiz.verificationStatus === "verified" && playable.length > 0
        ? { status: "ready", reason: null }
        : {
            status: "unavailable",
            reason:
              quiz.verificationStatus === "verified"
                ? "No concept has two verified questions. Generate a fresh review."
                : quiz.verificationStatus === "failed"
                  ? "Quality verification failed. Retry verification or generate a fresh review."
                  : "Quality verification is unavailable for this review.",
          };

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
    purpose: quiz.purpose,
    sourceQuizId: quiz.sourceQuizId,
    questionCount: playable.length,
    verificationStatus: quiz.verificationStatus,
    verifierModel: quiz.verifierModel,
    verificationSummary: summary,
    evidenceAvailable,
    generation: {
      status: quiz.generationStatus,
      readyCount: playable.length,
      targetCount: quiz.targetQuestionCount ?? playable.length,
      pendingBatchCount,
      failedBatchCount,
      hasMore: pendingBatchCount > 0,
    },
    reviewReadiness,
    questions: playable.map((q) => ({
      id: q.id,
      stem: q.stem,
      difficulty: q.difficulty,
      topic: q.topic,
      order: q.order,
      // Only the trust-badge label leaves the server, never the reasons.
      verdict: q.verdict, // null (unverified) | "pass" | "repaired"
      reviewConceptKey: q.reviewConceptKey,
      options: JSON.parse(q.options),
    })),
  });
}
