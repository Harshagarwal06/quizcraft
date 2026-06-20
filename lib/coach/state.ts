import { prisma } from "@/lib/db";
import { normalizeConceptKey } from "@/lib/mastery";
import { buildCoachCandidates, type CoachConceptState } from "./policy";
import {
  parseStringArray,
  toCoachActionDTO,
  type CoachActionDTO,
} from "./types";

export async function listAvailableCoachSources(userId: string) {
  const sources = await prisma.sourceDocument.findMany({
    where: {
      userId,
      quizzes: { some: { purpose: "standard", questionCount: { gt: 0 } } },
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      kind: true,
      quizzes: {
        where: { purpose: "standard", questionCount: { gt: 0 } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, title: true },
      },
    },
  });
  return sources.map((source) => ({
    id: source.id,
    title: source.title,
    kind: source.kind,
    quizId: source.quizzes[0]?.id ?? null,
    quizTitle: source.quizzes[0]?.title ?? source.title,
  }));
}

export async function getActivePlan(userId: string) {
  return prisma.studyPlan.findFirst({
    where: { userId, status: "active", activeKey: userId },
    include: {
      sources: {
        include: {
          sourceDocument: {
            select: { id: true, title: true, kind: true },
          },
        },
      },
      concepts: true,
      threads: {
        take: 1,
        include: {
          messages: {
            orderBy: { createdAt: "desc" },
            take: 20,
          },
        },
      },
    },
  });
}

export async function buildPlannerState(
  userId: string,
  studyPlanId: string,
  now = new Date()
) {
  const plan = await prisma.studyPlan.findFirst({
    where: { id: studyPlanId, userId, status: "active" },
    include: {
      sources: { select: { sourceDocumentId: true } },
      concepts: true,
    },
  });
  if (!plan) throw new Error("Active study plan not found.");
  const sourceIds = plan.sources.map((source) => source.sourceDocumentId);

  const [answers, reviews, dismissed] = await Promise.all([
    prisma.answerRecord.findMany({
      where: {
        attempt: { userId, completedAt: { not: null } },
        question: { quiz: { sourceDocumentId: { in: sourceIds } } },
      },
      orderBy: { attempt: { startedAt: "desc" } },
      take: 1000,
      select: {
        isCorrect: true,
        attempt: { select: { startedAt: true } },
        question: { select: { topic: true } },
      },
    }),
    prisma.conceptReview.findMany({
      where: {
        userId,
        stage: { lt: 6 },
        dueAt: { lte: now },
        sourceQuiz: { sourceDocumentId: { in: sourceIds } },
      },
      orderBy: [{ stage: "asc" }, { dueAt: "asc" }],
      select: {
        sourceQuizId: true,
        conceptKey: true,
        label: true,
        stage: true,
        sourceQuiz: {
          select: {
            title: true,
            sourceDocumentId: true,
          },
        },
      },
    }),
    prisma.coachAction.findMany({
      where: {
        studyPlanId,
        status: "dismissed",
        createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      },
      select: { type: true, conceptKeys: true, sourceDocumentIds: true },
    }),
  ]);

  const recentByConcept = new Map<
    string,
    { answered: number; incorrect: number; lastAnsweredAt: Date | null; lastIncorrectAt: Date | null }
  >();
  for (const answer of answers) {
    const key = normalizeConceptKey(answer.question.topic);
    const stats = recentByConcept.get(key) ?? {
      answered: 0,
      incorrect: 0,
      lastAnsweredAt: null,
      lastIncorrectAt: null,
    };
    if (stats.answered >= 12) continue;
    stats.answered += 1;
    stats.incorrect += answer.isCorrect ? 0 : 1;
    stats.lastAnsweredAt ??= answer.attempt.startedAt;
    if (!answer.isCorrect) stats.lastIncorrectAt ??= answer.attempt.startedAt;
    recentByConcept.set(key, stats);
  }

  const concepts: CoachConceptState[] = plan.concepts.map((concept) => {
    const recent = recentByConcept.get(concept.conceptKey);
    return {
      conceptKey: concept.conceptKey,
      label: concept.label,
      importance: concept.importance,
      answered: recent?.answered ?? 0,
      incorrect: recent?.incorrect ?? 0,
      lastAnsweredAt: recent?.lastAnsweredAt ?? concept.lastActivityAt,
      lastIncorrectAt: recent?.lastIncorrectAt ?? null,
      lastLessonAt: concept.lastLessonAt,
      sourceDocumentId: concept.sourceDocumentId,
      sourceQuizId: concept.sourceQuizId,
    };
  });

  const dueMap = new Map<
    string,
    {
      sourceQuizId: string;
      sourceDocumentId: string;
      quizTitle: string;
      concepts: { conceptKey: string; label: string; stage: number }[];
    }
  >();
  for (const review of reviews) {
    if (!review.sourceQuiz.sourceDocumentId) continue;
    const group = dueMap.get(review.sourceQuizId) ?? {
      sourceQuizId: review.sourceQuizId,
      sourceDocumentId: review.sourceQuiz.sourceDocumentId,
      quizTitle: review.sourceQuiz.title,
      concepts: [],
    };
    group.concepts.push({
      conceptKey: review.conceptKey,
      label: review.label,
      stage: review.stage,
    });
    dueMap.set(review.sourceQuizId, group);
  }

  const dismissedSignatures = new Set(
    dismissed.map((action) =>
      [
        action.type,
        parseStringArray(action.sourceDocumentIds).join(","),
        parseStringArray(action.conceptKeys).join(","),
      ].join(":")
    )
  );
  const candidates = buildCoachCandidates({
    concepts,
    dueReviews: [...dueMap.values()],
    examDate: plan.examDate,
    now,
    sourceCount: sourceIds.length,
  }).filter((candidate) => !dismissedSignatures.has(candidate.id));

  return { plan, concepts, candidates };
}

export async function buildCoachSnapshot(userId: string) {
  const [plan, availableSources] = await Promise.all([
    getActivePlan(userId),
    listAvailableCoachSources(userId),
  ]);
  if (!plan) {
    return {
      enabled: true,
      plan: null,
      availableSources,
      recommendation: null as CoachActionDTO | null,
      messages: [],
    };
  }

  const action = await prisma.coachAction.findFirst({
    where: {
      studyPlanId: plan.id,
      status: {
        in: ["proposed", "approved", "preparing", "ready", "failed"],
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const thread = plan.threads[0];
  return {
    enabled: true,
    plan: {
      id: plan.id,
      examTitle: plan.examTitle,
      examDate: plan.examDate.toISOString(),
      targetScore: plan.targetScore,
      dailyMinutes: plan.dailyMinutes,
      availableDays: parseStringArray(plan.availableDays).map(Number),
      stateVersion: plan.stateVersion,
      sources: plan.sources.map((source) => ({
        id: source.sourceDocument.id,
        title: source.sourceDocument.title,
        kind: source.sourceDocument.kind,
      })),
      conceptCount: plan.concepts.length,
    },
    availableSources,
    recommendation: action ? toCoachActionDTO(action) : null,
    messages: (thread?.messages ?? [])
      .slice()
      .reverse()
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        citations: message.citations ? JSON.parse(message.citations) : [],
        pendingPlanUpdate: message.pendingPlanUpdate
          ? JSON.parse(message.pendingPlanUpdate)
          : null,
        proposedActionId: message.proposedActionId,
        createdAt: message.createdAt.toISOString(),
      })),
  };
}
