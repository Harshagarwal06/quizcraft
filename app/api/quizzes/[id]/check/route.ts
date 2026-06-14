import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { z } from "zod";

const schema = z.object({
  questionId: z.string(),
  selectedOption: z.enum(["A", "B", "C", "D"]),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: quizId } = await params;
  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz || quiz.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const { questionId, selectedOption } = parsed.data;
  const question = await prisma.question.findFirst({
    where: { id: questionId, quizId },
    select: { correctOption: true, explanation: true },
  });

  if (!question) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  return NextResponse.json({
    isCorrect: selectedOption === question.correctOption,
    correctOption: question.correctOption,
    explanation: question.explanation,
  });
}
