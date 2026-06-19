export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { normalizeConceptKey, selectDueConcepts } from "@/lib/mastery";
import { generateWithFallback } from "@/lib/llm";
import { shuffleQuizOptions } from "@/lib/llm/shuffle";
import { REVIEW_GENERATOR_PROMPT_HASH } from "@/lib/llm/prompt";
import { HF_MODEL_NAME, geminiModelName } from "@/lib/llm/client";
import { createEvidenceReviewQuiz } from "@/lib/pipeline/quiz-pipeline";

const requestSchema = z.object({
  sourceQuizId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const requestStart = Date.now();
  const userId = await getCurrentUserId();
  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const source = await prisma.quiz.findFirst({
    where: {
      id: parsed.data.sourceQuizId,
      userId,
      purpose: "standard",
    },
    select: {
      id: true,
      title: true,
      sourceType: true,
      sourceSummary: true,
      groundingText: true,
      sourceDocumentId: true,
    },
  });
  if (!source) {
    return NextResponse.json({ error: "Source quiz not found" }, { status: 404 });
  }
  if (!source.groundingText || source.groundingText.trim().length < 20) {
    return NextResponse.json(
      { error: "The source material is unavailable for targeted review." },
      { status: 409 }
    );
  }

  const now = new Date();
  const reviewStates = await prisma.conceptReview.findMany({
    where: { userId, sourceQuizId: source.id, stage: { lt: 6 } },
    select: {
      conceptKey: true,
      label: true,
      stage: true,
      consecutiveCorrect: true,
      dueAt: true,
      createdAt: true,
    },
  });
  const selected = selectDueConcepts(reviewStates, now, 3);
  if (selected.length === 0) {
    return NextResponse.json(
      { error: "No concepts are due for review.", code: "NO_DUE_REVIEW" },
      { status: 409 }
    );
  }

  const priorQuestions = await prisma.question.findMany({
    where: {
      OR: [
        { quizId: source.id },
        { quiz: { sourceQuizId: source.id, purpose: "review" } },
      ],
    },
    select: { stem: true, topic: true, reviewConceptKey: true },
    orderBy: { quiz: { createdAt: "desc" } },
    take: 120,
  });

  const concepts = selected.map((concept) => ({
    key: concept.conceptKey,
    label: concept.label,
    recentStems: priorQuestions
      .filter(
        (question) =>
          question.reviewConceptKey === concept.conceptKey ||
          (!question.reviewConceptKey &&
            normalizeConceptKey(question.topic) === concept.conceptKey)
      )
      .map((question) => question.stem)
      .slice(0, 12),
  }));

  if (
    process.env.EVIDENCE_PIPELINE_ENABLED !== "false" &&
    source.sourceDocumentId
  ) {
    try {
      const review = await createEvidenceReviewQuiz({
        userId,
        sourceQuizId: source.id,
        sourceDocumentId: source.sourceDocumentId,
        sourceTitle: source.title,
        sourceType: source.sourceType,
        concepts: concepts.map((concept) => ({
          key: concept.key,
          label: concept.label,
        })),
      });
      return NextResponse.json({ id: review.id }, { status: 201 });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return NextResponse.json(
        { error: "Couldn't prepare the cited mastery review.", detail },
        { status: 502 }
      );
    }
  }

  try {
    const preferred = process.env.LLM_PROVIDER ?? "hf";
    const { quiz: generatedRaw, provider } = await generateWithFallback(
      {
        sourceText: source.groundingText,
        questionCount: concepts.length * 2,
        seed: Math.floor(Math.random() * 1_000_000),
        review: { concepts },
      },
      preferred,
      requestStart + 56_000
    );
    const generated = shuffleQuizOptions(generatedRaw);
    const conceptKeyByLabel = new Map(
      concepts.map((concept) => [concept.label, concept.key])
    );

    const reviewQuiz = await prisma.quiz.create({
      data: {
        userId,
        title: `Review: ${source.title}`,
        sourceType: source.sourceType,
        sourceSummary: source.sourceSummary,
        questionCount: generated.questions.length,
        purpose: "review",
        sourceQuizId: source.id,
        groundingText: source.groundingText.slice(0, 60000),
        generatorModel:
          provider === "gemini" ? geminiModelName() : HF_MODEL_NAME,
        generatorPromptHash: REVIEW_GENERATOR_PROMPT_HASH,
        questions: {
          create: generated.questions.map((question, order) => ({
            stem: question.stem,
            options: JSON.stringify(question.options),
            correctOption: question.correctOptionId,
            explanation: question.explanation,
            difficulty: question.difficulty,
            topic: question.topic,
            order,
            reviewConceptKey: conceptKeyByLabel.get(question.topic),
          })),
        },
      },
      select: { id: true },
    });

    const verifyUrl = `${req.nextUrl.origin}/api/quizzes/${reviewQuiz.id}/verify`;
    after(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      try {
        await fetch(verifyUrl, {
          method: "POST",
          signal: controller.signal,
        });
      } catch {
        // The review preparation screen retries this idempotent trigger.
      } finally {
        clearTimeout(timer);
      }
    });

    return NextResponse.json({ id: reviewQuiz.id }, { status: 201 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[reviews] generation failed:", error);
    return NextResponse.json(
      { error: "Couldn't prepare the targeted review.", detail },
      { status: 502 }
    );
  }
}
