import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  if (!quiz || quiz.userId !== session.user.id) {
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
