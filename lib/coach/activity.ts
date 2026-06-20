import { prisma } from "@/lib/db";
import { normalizeConceptKey } from "@/lib/mastery";
import { smoothedWeakness } from "./policy";

export async function recordCoachQuizActivity(input: {
  userId: string;
  quizId: string;
  sourceDocumentId: string | null;
  sourceQuizId: string | null;
  topics: string[];
  completedAt: Date;
}): Promise<string | null> {
  let sourceDocumentId = input.sourceDocumentId;
  if (!sourceDocumentId && input.sourceQuizId) {
    sourceDocumentId = (
      await prisma.quiz.findUnique({
        where: { id: input.sourceQuizId },
        select: { sourceDocumentId: true },
      })
    )?.sourceDocumentId ?? null;
  }
  if (!sourceDocumentId) return null;

  const plan = await prisma.studyPlan.findFirst({
    where: {
      userId: input.userId,
      status: "active",
      activeKey: input.userId,
      sources: { some: { sourceDocumentId } },
    },
    select: { id: true },
  });
  if (!plan) return null;

  const conceptKeys = [
    ...new Set(input.topics.map((topic) => normalizeConceptKey(topic))),
  ];
  const answers = await prisma.answerRecord.findMany({
    where: {
      attempt: { userId: input.userId, completedAt: { not: null } },
      question: {
        topic: { in: input.topics },
        quiz: { sourceDocumentId },
      },
    },
    orderBy: { attempt: { startedAt: "desc" } },
    take: Math.max(12, conceptKeys.length * 12),
    select: {
      isCorrect: true,
      question: { select: { topic: true } },
    },
  });
  const stats = new Map<string, { answered: number; incorrect: number }>();
  for (const answer of answers) {
    const key = normalizeConceptKey(answer.question.topic);
    if (!conceptKeys.includes(key)) continue;
    const current = stats.get(key) ?? { answered: 0, incorrect: 0 };
    if (current.answered >= 12) continue;
    current.answered += 1;
    current.incorrect += answer.isCorrect ? 0 : 1;
    stats.set(key, current);
  }

  await prisma.$transaction(async (tx) => {
    for (const conceptKey of conceptKeys) {
      const value = stats.get(conceptKey) ?? { answered: 0, incorrect: 0 };
      await tx.planConcept.updateMany({
        where: { studyPlanId: plan.id, conceptKey },
        data: {
          proficiency: 1 - smoothedWeakness(value.incorrect, value.answered),
          lastActivityAt: input.completedAt,
        },
      });
    }
    await tx.coachAction.updateMany({
      where: {
        studyPlanId: plan.id,
        generatedQuizId: input.quizId,
        status: { in: ["ready", "started"] },
      },
      data: { status: "completed", completedAt: input.completedAt },
    });
    await tx.coachAction.updateMany({
      where: { studyPlanId: plan.id, status: "proposed" },
      data: { status: "dismissed" },
    });
    await tx.studyPlan.update({
      where: { id: plan.id },
      data: { stateVersion: { increment: 1 } },
    });
  });
  return plan.id;
}
