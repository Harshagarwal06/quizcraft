import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
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
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const { quizId, answers } = parsed.data;

  // Verify quiz belongs to user
  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz || quiz.userId !== session.user.id) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  // Fetch correct answers from server — never trust client
  const questions = await prisma.question.findMany({
    where: { quizId },
    select: { id: true, correctOption: true, explanation: true, stem: true, options: true, difficulty: true, topic: true },
  });

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
  };

  const questionMap = new Map(questions.map((q) => [q.id, q]));

  const scoredAnswers: ScoredAnswer[] = [];
  for (const a of answers) {
    const q = questionMap.get(a.questionId);
    if (!q) continue;
    scoredAnswers.push({
      questionId: a.questionId,
      selectedOption: a.selectedOption,
      isCorrect: a.selectedOption === q.correctOption,
      timeMs: a.timeMs,
      correctOption: q.correctOption,
      explanation: q.explanation,
      stem: q.stem,
      options: JSON.parse(q.options) as { id: string; text: string }[],
      difficulty: q.difficulty,
      topic: q.topic,
    });
  }

  const score = scoredAnswers.filter((a) => a.isCorrect).length;

  const attempt = await prisma.attempt.create({
    data: {
      quizId,
      userId: session.user.id,
      completedAt: new Date(),
      score,
      totalQuestions: scoredAnswers.length,
      answerRecords: {
        create: scoredAnswers.map((a) => ({
          questionId: a.questionId,
          selectedOption: a.selectedOption,
          isCorrect: a.isCorrect,
          timeMs: a.timeMs,
        })),
      },
    },
    select: { id: true },
  });

  return NextResponse.json({
    attemptId: attempt.id,
    score,
    total: scoredAnswers.length,
    results: scoredAnswers,
  });
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const attempts = await prisma.attempt.findMany({
    where: { userId: session.user.id, completedAt: { not: null } },
    orderBy: { startedAt: "desc" },
    take: 50,
    include: {
      quiz: { select: { title: true, sourceType: true } },
      _count: { select: { answerRecords: true } },
    },
  });

  return NextResponse.json(attempts);
}
