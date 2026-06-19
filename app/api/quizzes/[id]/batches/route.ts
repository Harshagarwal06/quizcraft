export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentUserId } from "@/lib/currentUser";
import { processEvidenceBatch } from "@/lib/pipeline/quiz-pipeline";

const bodySchema = z.object({
  retryFailed: z.boolean().optional().default(false),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getCurrentUserId();
  const { id } = await params;
  const quiz = await prisma.quiz.findFirst({
    where: { id, userId },
    select: { id: true, sourceDocumentId: true },
  });
  if (!quiz) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }
  if (!quiz.sourceDocumentId) {
    return NextResponse.json(
      { error: "Legacy quizzes do not have generation batches." },
      { status: 409 }
    );
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const status = parsed.data.retryFailed ? "failed" : "pending";
  const batches = await prisma.quizGenerationBatch.findMany({
    where: { quizId: id, status },
    orderBy: { batchIndex: "asc" },
    take: 2,
    select: { batchIndex: true },
  });
  if (batches.length === 0) {
    const [state, activeBatchCount] = await Promise.all([
      prisma.quiz.findUniqueOrThrow({
        where: { id },
        select: {
          questionCount: true,
          targetQuestionCount: true,
          generationStatus: true,
        },
      }),
      prisma.quizGenerationBatch.count({
        where: { quizId: id, status: { in: ["generating", "verifying"] } },
      }),
    ]);
    const busy = activeBatchCount > 0;
    return NextResponse.json(
      {
        status: busy ? "busy" : state.generationStatus,
        readyCount: state.questionCount,
        targetCount: state.targetQuestionCount ?? state.questionCount,
        batches: [],
      },
      { status: busy ? 202 : 200 }
    );
  }

  const results = await Promise.all(
    batches.map((batch) => processEvidenceBatch(id, batch.batchIndex))
  );
  const busy = results.every((result) => result.status === "busy");
  return NextResponse.json(
    {
      status: busy ? "busy" : "processed",
      readyCount: Math.max(...results.map((result) => result.readyCount)),
      targetCount: Math.max(...results.map((result) => result.targetCount)),
      batches: results,
    },
    { status: busy ? 202 : 200 }
  );
}
