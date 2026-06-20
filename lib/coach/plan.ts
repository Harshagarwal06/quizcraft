import { prisma } from "@/lib/db";
import { normalizeConceptKey } from "@/lib/mastery";

type CreatePlanInput = {
  examTitle: string;
  examDate: Date;
  targetScore: number;
  dailyMinutes: number;
  availableDays: number[];
  sourceDocumentIds: string[];
};

type ConceptAccumulator = {
  conceptKey: string;
  label: string;
  sourceDocumentId: string;
  sourceQuizId: string | null;
  objectives: Set<string>;
  seedChunkIds: Set<string>;
  count: number;
};

export async function createStudyPlan(
  userId: string,
  input: CreatePlanInput
) {
  const existing = await prisma.studyPlan.findFirst({
    where: { userId, status: "active" },
    select: { id: true },
  });
  if (existing) {
    throw new Error("ACTIVE_PLAN_EXISTS");
  }

  const sources = await prisma.sourceDocument.findMany({
    where: {
      id: { in: input.sourceDocumentIds },
      userId,
    },
    include: {
      chunks: {
        orderBy: { ordinal: "asc" },
        take: 12,
        select: { id: true, section: true },
      },
      quizzes: {
        where: { purpose: "standard", questionCount: { gt: 0 } },
        orderBy: { createdAt: "desc" },
        include: {
          blueprintItems: { orderBy: { slot: "asc" } },
          questions: {
            orderBy: { order: "asc" },
            select: { topic: true },
          },
        },
      },
    },
  });
  if (sources.length !== new Set(input.sourceDocumentIds).size) {
    throw new Error("SOURCE_NOT_FOUND");
  }

  const concepts = new Map<string, ConceptAccumulator>();
  for (const source of sources) {
    const quiz = source.quizzes[0];
    const blueprint = quiz?.blueprintItems ?? [];
    if (blueprint.length > 0) {
      for (const item of blueprint) {
        const key = item.conceptKey || normalizeConceptKey(item.topic);
        const current = concepts.get(key) ?? {
          conceptKey: key,
          label: item.topic,
          sourceDocumentId: source.id,
          sourceQuizId: quiz?.id ?? null,
          objectives: new Set<string>(),
          seedChunkIds: new Set<string>(),
          count: 0,
        };
        current.objectives.add(item.objective);
        for (const id of JSON.parse(item.seedChunkIds) as string[]) {
          current.seedChunkIds.add(id);
        }
        current.count += 1;
        concepts.set(key, current);
      }
    } else if (quiz) {
      for (const question of quiz.questions) {
        const key = normalizeConceptKey(question.topic);
        const current = concepts.get(key) ?? {
          conceptKey: key,
          label: question.topic,
          sourceDocumentId: source.id,
          sourceQuizId: quiz.id,
          objectives: new Set<string>(),
          seedChunkIds: new Set<string>(),
          count: 0,
        };
        current.objectives.add(`Understand ${question.topic}`);
        current.count += 1;
        concepts.set(key, current);
      }
    } else {
      for (const chunk of source.chunks) {
        const label = chunk.section || source.title;
        const key = normalizeConceptKey(label);
        const current = concepts.get(key) ?? {
          conceptKey: key,
          label,
          sourceDocumentId: source.id,
          sourceQuizId: null,
          objectives: new Set<string>(),
          seedChunkIds: new Set<string>(),
          count: 0,
        };
        current.objectives.add(`Understand ${label}`);
        current.seedChunkIds.add(chunk.id);
        current.count += 1;
        concepts.set(key, current);
      }
    }
  }

  const maxCount = Math.max(1, ...[...concepts.values()].map((item) => item.count));
  return prisma.studyPlan.create({
    data: {
      userId,
      examTitle: input.examTitle,
      examDate: input.examDate,
      targetScore: input.targetScore,
      dailyMinutes: input.dailyMinutes,
      availableDays: JSON.stringify(
        [...new Set(input.availableDays)].sort((a, b) => a - b)
      ),
      activeKey: userId,
      sources: {
        create: sources.map((source) => ({
          sourceDocumentId: source.id,
        })),
      },
      concepts: {
        create: [...concepts.values()].map((concept) => ({
          sourceDocumentId: concept.sourceDocumentId,
          sourceQuizId: concept.sourceQuizId,
          conceptKey: concept.conceptKey,
          label: concept.label,
          importance: Math.max(0.25, concept.count / maxCount),
          objectives: JSON.stringify([...concept.objectives].slice(0, 5)),
          seedChunkIds: JSON.stringify([...concept.seedChunkIds].slice(0, 3)),
        })),
      },
      threads: { create: {} },
    },
  });
}

export async function updateStudyPlan(
  userId: string,
  planId: string,
  changes: Partial<{
    examTitle: string;
    examDate: Date;
    targetScore: number;
    dailyMinutes: number;
    availableDays: number[];
  }>
) {
  const plan = await prisma.studyPlan.findFirst({
    where: { id: planId, userId, status: "active" },
    select: { id: true },
  });
  if (!plan) throw new Error("PLAN_NOT_FOUND");
  return prisma.$transaction(async (tx) => {
    await tx.coachAction.updateMany({
      where: { studyPlanId: planId, status: "proposed" },
      data: { status: "dismissed" },
    });
    await tx.coachMessage.updateMany({
      where: {
        thread: { studyPlanId: planId },
        pendingPlanUpdate: { not: null },
      },
      data: { pendingPlanUpdate: null },
    });
    return tx.studyPlan.update({
      where: { id: planId },
      data: {
        examTitle: changes.examTitle,
        examDate: changes.examDate,
        targetScore: changes.targetScore,
        dailyMinutes: changes.dailyMinutes,
        availableDays: changes.availableDays
          ? JSON.stringify(
              [...new Set(changes.availableDays)].sort((a, b) => a - b)
            )
          : undefined,
        stateVersion: { increment: 1 },
      },
    });
  });
}
