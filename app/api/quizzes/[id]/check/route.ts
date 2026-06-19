import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { playableReviewQuestions } from "@/lib/mastery";
import { z } from "zod";

const schema = z.object({
  questionId: z.string(),
  selectedOption: z.enum(["A", "B", "C", "D"]),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getCurrentUserId();

  const { id: quizId } = await params;
  const quiz = await prisma.quiz.findUnique({
    where: { id: quizId },
    select: {
      id: true,
      userId: true,
      purpose: true,
      sourceDocumentId: true,
      verificationStatus: true,
      questions: {
        select: {
          id: true,
          verdict: true,
          reviewConceptKey: true,
        },
      },
    },
  });
  if (!quiz || quiz.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const { questionId, selectedOption } = parsed.data;
  if (quiz.purpose === "review") {
    if (quiz.verificationStatus !== "verified") {
      return NextResponse.json(
        { error: "Review quality verification is not complete." },
        { status: 409 }
      );
    }
    const playable = playableReviewQuestions(quiz.questions);
    if (!playable.some((question) => question.id === questionId)) {
      return NextResponse.json(
        { error: "This review question is not playable." },
        { status: 409 }
      );
    }
  }
  const question = await prisma.question.findFirst({
    where: { id: questionId, quizId },
    select: {
      correctOption: true,
      explanation: true,
      optionExplanations: true,
      verdict: true,
      evidenceStatus: true,
      evidence: {
        orderBy: { displayOrder: "asc" },
        select: {
          quote: true,
          sourceChunk: {
            select: {
              pageStart: true,
              pageEnd: true,
              section: true,
              sourceDocument: { select: { title: true, originUrl: true } },
              references: {
                include: { sourceReference: true },
              },
            },
          },
        },
      },
    },
  });

  if (!question) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }
  if (
    quiz.sourceDocumentId &&
    (!["pass", "repaired"].includes(question.verdict ?? "") ||
      question.evidenceStatus !== "valid")
  ) {
    return NextResponse.json(
      { error: "This question is not verified for play." },
      { status: 409 }
    );
  }

  return NextResponse.json({
    isCorrect: selectedOption === question.correctOption,
    correctOption: question.correctOption,
    explanation: question.explanation,
    optionExplanations: question.optionExplanations
      ? JSON.parse(question.optionExplanations)
      : null,
    evidence: question.evidence.flatMap((item) => {
      const references = item.sourceChunk.references.map(
        (entry) => entry.sourceReference
      );
      if (references.length === 0) {
        return [
          {
            quote: item.quote,
            sourceTitle: item.sourceChunk.sourceDocument.title,
            pageStart: item.sourceChunk.pageStart,
            pageEnd: item.sourceChunk.pageEnd,
            section: item.sourceChunk.section,
            url: item.sourceChunk.sourceDocument.originUrl,
          },
        ];
      }
      return references.map((reference) => ({
        quote: item.quote,
        sourceTitle: reference.title,
        pageStart: item.sourceChunk.pageStart,
        pageEnd: item.sourceChunk.pageEnd,
        section: item.sourceChunk.section,
        url: reference.url,
      }));
    }),
  });
}
