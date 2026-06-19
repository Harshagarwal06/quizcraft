import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import {
  applyReviewAnswers,
  collectStandardMistakes,
  validateReviewSubmission,
  type ConceptTransition,
} from "@/lib/mastery";
import { z } from "zod";

const submitSchema = z.object({
  quizId: z.string(),
  answers: z.array(
    z.object({
      questionId: z.string(),
      selectedOption: z.enum(["A", "B", "C", "D"]),
      timeMs: z.number().int().optional(),
    })
  ),
});

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId();
  const parsed = submitSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const { quizId, answers } = parsed.data;
  const quiz = await prisma.quiz.findFirst({
    where: { id: quizId, userId },
    select: {
      id: true,
      purpose: true,
      sourceQuizId: true,
      verificationStatus: true,
    },
  });
  if (!quiz) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  const questions = await prisma.question.findMany({
    where: { quizId },
    orderBy: { order: "asc" },
    select: {
      id: true,
      correctOption: true,
      explanation: true,
      stem: true,
      options: true,
      difficulty: true,
      topic: true,
      verdict: true,
      order: true,
      reviewConceptKey: true,
    },
  });

  if (quiz.purpose === "review") {
    if (quiz.verificationStatus !== "verified") {
      return NextResponse.json(
        { error: "Review quality verification is not complete." },
        { status: 409 }
      );
    }
    const validation = validateReviewSubmission(
      questions,
      answers.map((answer) => answer.questionId)
    );
    if (!validation.ok) {
      return NextResponse.json({ error: validation.reason }, { status: 400 });
    }
  }

  type ScoredAnswer = {
    questionId: string;
    selectedOption: string;
    isCorrect: boolean;
    timeMs: number | undefined;
    correctOption: string;
    explanation: string;
    stem: string;
    options: { id: string; text: string }[];
    difficulty: string;
    topic: string;
    order: number;
    reviewConceptKey: string | null;
  };

  const questionMap = new Map(questions.map((question) => [question.id, question]));
  const scoredAnswers: ScoredAnswer[] = [];
  for (const answer of answers) {
    const question = questionMap.get(answer.questionId);
    if (!question || question.verdict === "flagged") continue;
    scoredAnswers.push({
      questionId: answer.questionId,
      selectedOption: answer.selectedOption,
      isCorrect: answer.selectedOption === question.correctOption,
      timeMs: answer.timeMs,
      correctOption: question.correctOption,
      explanation: question.explanation,
      stem: question.stem,
      options: JSON.parse(question.options) as { id: string; text: string }[],
      difficulty: question.difficulty,
      topic: question.topic,
      order: question.order,
      reviewConceptKey: question.reviewConceptKey,
    });
  }
  scoredAnswers.sort((a, b) => a.order - b.order);

  const score = scoredAnswers.filter((answer) => answer.isCorrect).length;
  const now = new Date();
  let masteryChanges: ConceptTransition[] = [];

  try {
    const attempt = await prisma.$transaction(async (tx) => {
      const created = await tx.attempt.create({
        data: {
          quizId,
          userId,
          completedAt: now,
          score,
          totalQuestions: scoredAnswers.length,
          answerRecords: {
            create: scoredAnswers.map((answer) => ({
              questionId: answer.questionId,
              selectedOption: answer.selectedOption,
              isCorrect: answer.isCorrect,
              timeMs: answer.timeMs,
            })),
          },
        },
        select: { id: true },
      });

      if (quiz.purpose === "standard") {
        const mistakes = collectStandardMistakes(scoredAnswers);
        for (const [conceptKey, label] of mistakes) {
          await tx.conceptReview.upsert({
            where: {
              userId_sourceQuizId_conceptKey: {
                userId,
                sourceQuizId: quiz.id,
                conceptKey,
              },
            },
            create: {
              userId,
              sourceQuizId: quiz.id,
              conceptKey,
              label,
              stage: 0,
              consecutiveCorrect: 0,
              dueAt: now,
              lastReviewedAt: now,
            },
            update: {
              label,
              stage: 0,
              consecutiveCorrect: 0,
              dueAt: now,
              lastReviewedAt: now,
            },
          });
        }
      } else {
        if (!quiz.sourceQuizId) {
          throw new Error("Review quiz is missing its source quiz.");
        }
        const keys = [
          ...new Set(
            scoredAnswers
              .map((answer) => answer.reviewConceptKey)
              .filter((key): key is string => Boolean(key))
          ),
        ];
        const currentStates = await tx.conceptReview.findMany({
          where: {
            userId,
            sourceQuizId: quiz.sourceQuizId,
            conceptKey: { in: keys },
          },
        });
        const byKey = new Map(
          currentStates.map((state) => [state.conceptKey, state])
        );
        const answersByKey = new Map<string, boolean[]>();
        for (const answer of scoredAnswers) {
          if (!answer.reviewConceptKey) continue;
          const values = answersByKey.get(answer.reviewConceptKey) ?? [];
          values.push(answer.isCorrect);
          answersByKey.set(answer.reviewConceptKey, values);
        }

        masteryChanges = [];
        for (const [conceptKey, correctness] of answersByKey) {
          const current = byKey.get(conceptKey);
          if (!current) throw new Error(`Missing mastery state for ${conceptKey}`);
          const transition = applyReviewAnswers(
            {
              conceptKey: current.conceptKey,
              label: current.label,
              stage: current.stage,
              consecutiveCorrect: current.consecutiveCorrect,
              dueAt: current.dueAt,
            },
            correctness,
            now
          );
          masteryChanges.push(transition);
          await tx.conceptReview.update({
            where: { id: current.id },
            data: {
              stage: transition.stage,
              consecutiveCorrect: transition.consecutiveCorrect,
              dueAt: transition.dueAt,
              lastReviewedAt: transition.lastReviewedAt,
            },
          });
        }
      }

      return created;
    });

    const sourceQuizId =
      quiz.purpose === "review" ? quiz.sourceQuizId : quiz.id;
    const activeStates = sourceQuizId
      ? await prisma.conceptReview.findMany({
          where: { userId, sourceQuizId, stage: { lt: 6 } },
          select: { dueAt: true },
          orderBy: { dueAt: "asc" },
        })
      : [];
    const dueConceptCount = activeStates.filter(
      (state) => state.dueAt && state.dueAt.getTime() <= now.getTime()
    ).length;
    const nextDueAt =
      activeStates.find((state) => state.dueAt !== null)?.dueAt ?? null;

    return NextResponse.json({
      attemptId: attempt.id,
      score,
      total: scoredAnswers.length,
      results: scoredAnswers.map((answer) => ({
        questionId: answer.questionId,
        selectedOption: answer.selectedOption,
        isCorrect: answer.isCorrect,
        timeMs: answer.timeMs,
        correctOption: answer.correctOption,
        explanation: answer.explanation,
        stem: answer.stem,
        options: answer.options,
        difficulty: answer.difficulty,
        topic: answer.topic,
      })),
      masteryChanges,
      dueConceptCount,
      canPracticeMistakes: quiz.purpose === "standard" && dueConceptCount > 0,
      canContinueReview: quiz.purpose === "review" && dueConceptCount > 0,
      nextDueAt,
      sourceQuizId,
    });
  } catch (error) {
    console.error("[attempts] save failed:", error);
    return NextResponse.json(
      { error: "Failed to save this attempt." },
      { status: 500 }
    );
  }
}

export async function GET() {
  const userId = await getCurrentUserId();

  const attempts = await prisma.attempt.findMany({
    where: { userId, completedAt: { not: null } },
    orderBy: { startedAt: "desc" },
    take: 50,
    include: {
      quiz: { select: { title: true, sourceType: true, purpose: true } },
      _count: { select: { answerRecords: true } },
    },
  });

  return NextResponse.json(attempts);
}
