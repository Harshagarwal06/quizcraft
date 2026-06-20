export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { toCoachActionDTO } from "@/lib/coach/types";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getCurrentUserId();
  const { id } = await params;
  const lesson = await prisma.coachLesson.findFirst({
    where: { id, studyPlan: { userId, status: "active" } },
    include: {
      studyPlan: true,
      action: true,
    },
  });
  if (!lesson) {
    return NextResponse.json({ error: "Lesson not found." }, { status: 404 });
  }
  const concept = await prisma.planConcept.findUnique({
    where: {
      studyPlanId_conceptKey: {
        studyPlanId: lesson.studyPlanId,
        conceptKey: lesson.conceptKey,
      },
    },
  });
  if (!concept?.sourceQuizId) {
    return NextResponse.json(
      { error: "This lesson does not have a quiz source for a verified review." },
      { status: 409 }
    );
  }
  const sourceQuiz = await prisma.quiz.findFirst({
    where: {
      id: concept.sourceQuizId,
      userId,
      purpose: "standard",
      sourceDocumentId: concept.sourceDocumentId,
    },
    select: { id: true },
  });
  if (!sourceQuiz) {
    return NextResponse.json(
      { error: "The lesson's source quiz is unavailable." },
      { status: 409 }
    );
  }

  const now = new Date();
  const action = await prisma.$transaction(async (tx) => {
    await tx.coachLesson.update({
      where: { id: lesson.id },
      data: { completedAt: lesson.completedAt ?? now },
    });
    await tx.coachAction.update({
      where: { id: lesson.actionId },
      data: { status: "completed", completedAt: now },
    });
    await tx.planConcept.update({
      where: { id: concept.id },
      data: { lastLessonAt: now, lastActivityAt: now },
    });
    await tx.conceptReview.upsert({
      where: {
        userId_sourceQuizId_conceptKey: {
          userId,
          sourceQuizId: sourceQuiz.id,
          conceptKey: concept.conceptKey,
        },
      },
      create: {
        userId,
        sourceQuizId: sourceQuiz.id,
        conceptKey: concept.conceptKey,
        label: concept.label,
        stage: 0,
        consecutiveCorrect: 0,
        dueAt: now,
        lastReviewedAt: null,
      },
      update: {
        label: concept.label,
        dueAt: now,
      },
    });
    await tx.coachAction.updateMany({
      where: { studyPlanId: lesson.studyPlanId, status: "proposed" },
      data: { status: "dismissed" },
    });
    const plan = await tx.studyPlan.update({
      where: { id: lesson.studyPlanId },
      data: { stateVersion: { increment: 1 } },
      select: { stateVersion: true },
    });
    return tx.coachAction.create({
      data: {
        studyPlanId: lesson.studyPlanId,
        type: "review",
        title: `Test ${concept.label}`,
        rationale:
          "You completed the lesson. A fresh verified question pair will check whether the concept is sticking.",
        estimatedMinutes: 6,
        conceptKeys: JSON.stringify([concept.conceptKey]),
        sourceDocumentIds: JSON.stringify([concept.sourceDocumentId]),
        payload: JSON.stringify({ sourceQuizId: sourceQuiz.id }),
        planStateVersion: plan.stateVersion,
      },
    });
  });
  return NextResponse.json({ action: toCoachActionDTO(action) }, { status: 201 });
}
