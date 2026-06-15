export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { getGenerator } from "@/lib/llm";
import { extractText } from "@/lib/extract";
import { z } from "zod";

const generateSchema = z.object({
  sourceType: z.enum(["notes", "prompt"]),
  content: z.string().min(10).max(100000),
  userPrompt: z.string().max(500).optional(),
  questionCount: z.number().int().min(3).max(30).default(10),
});

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId();

  const contentType = req.headers.get("content-type") ?? "";
  let sourceType: string;
  let sourceText: string;
  let userPrompt: string | undefined;
  let questionCount = 10;

  if (contentType.includes("multipart/form-data")) {
    // PDF upload
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
    const buffer = Buffer.from(await file.arrayBuffer());
    sourceText = await extractText({ type: "pdf", buffer });
    userPrompt = (form.get("userPrompt") as string) || undefined;
    questionCount = Number(form.get("questionCount")) || 10;
    sourceType = "pdf";
  } else {
    const body = await req.json();
    const parsed = generateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }
    sourceText = await extractText({ type: "text", content: parsed.data.content });
    userPrompt = parsed.data.userPrompt;
    questionCount = parsed.data.questionCount;
    sourceType = parsed.data.sourceType;
  }

  if (sourceText.length < 20) {
    return NextResponse.json({ error: "Source text too short" }, { status: 400 });
  }

  const generator = getGenerator();
  const generated = await generator.generate({
    sourceText,
    userPrompt,
    questionCount,
    seed: Math.floor(Math.random() * 1_000_000),
  });

  const quiz = await prisma.quiz.create({
    data: {
      userId,
      title: generated.title,
      sourceType,
      sourceSummary: sourceText.slice(0, 300),
      questionCount: generated.questions.length,
      questions: {
        create: generated.questions.map((q, i) => ({
          stem: q.stem,
          options: JSON.stringify(q.options),
          correctOption: q.correctOptionId,
          explanation: q.explanation,
          difficulty: q.difficulty,
          topic: q.topic,
          order: i,
        })),
      },
    },
    select: { id: true, title: true, questionCount: true },
  });

  return NextResponse.json(quiz, { status: 201 });
}

export async function GET() {
  const userId = await getCurrentUserId();

  const quizzes = await prisma.quiz.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      sourceType: true,
      questionCount: true,
      createdAt: true,
      _count: { select: { attempts: true } },
    },
  });

  return NextResponse.json(quizzes);
}
