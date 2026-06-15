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
          // correctOption and explanation are intentionally excluded from play payload
        },
      },
    },
  });

  if (!quiz || quiz.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: quiz.id,
    title: quiz.title,
    questionCount: quiz.questionCount,
    questions: quiz.questions.map((q) => ({
      ...q,
      options: JSON.parse(q.options),
    })),
  });
}
