export const dynamic = "force-dynamic";
// Allow up to 60s — LLM generation can take 30-40s (Vercel default is shorter).
export const maxDuration = 60;

import { NextRequest, NextResponse, after } from "next/server";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { generateWithFallback } from "@/lib/llm";
import { GENERATOR_PROMPT_HASH } from "@/lib/llm/prompt";
import { HF_MODEL_NAME, geminiModelName } from "@/lib/llm/client";
import { shuffleQuizOptions } from "@/lib/llm/shuffle";
import { expandTopic } from "@/lib/expand";
import { extractSource, type ExtractedSource } from "@/lib/extract";
import { createEvidenceQuiz } from "@/lib/pipeline/quiz-pipeline";
import {
  researchGroundedTopic,
  WebGroundingError,
} from "@/lib/source/web-grounding";
import type { GroundedReference } from "@/lib/source/store";
import { recordGenerationTrace } from "@/lib/pipeline/trace";
import { z } from "zod";

const generateSchema = z.object({
  sourceType: z.enum(["notes", "prompt"]),
  content: z.string().min(10).max(100000),
  userPrompt: z.string().max(500).optional(),
  questionCount: z.number().int().min(3).max(15).default(8),
});

export async function POST(req: NextRequest) {
  const reqStart = Date.now();
  const evidenceEnabled = process.env.EVIDENCE_PIPELINE_ENABLED !== "false";
  let userId: string;
  try {
    userId = await getCurrentUserId();
  } catch (err) {
    console.error("[quizzes] database unavailable:", err);
    return NextResponse.json(
      { error: "Database is not set up. Run the Turso migration (npm run db:deploy)." },
      { status: 503 }
    );
  }

  const contentType = req.headers.get("content-type") ?? "";
  let sourceType: "pdf" | "notes" | "prompt";
  let sourceText: string;
  let sourceTitle: string;
  let extractedSource: ExtractedSource;
  let groundedReferences: GroundedReference[] | undefined;
  let userPrompt: string | undefined;
  let questionCount = 10;

  if (contentType.includes("multipart/form-data")) {
    // PDF upload
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
    const buffer = Buffer.from(await file.arrayBuffer());
    extractedSource = await extractSource({
      type: "pdf",
      buffer,
      title: file.name.replace(/\.pdf$/i, ""),
    });
    sourceText = extractedSource.fullText;
    sourceTitle = extractedSource.title || file.name.replace(/\.pdf$/i, "");
    userPrompt = (form.get("userPrompt") as string) || undefined;
    questionCount = Math.min(15, Math.max(3, Number(form.get("questionCount")) || 8));
    sourceType = "pdf";
  } else {
    const body = await req.json();
    const parsed = generateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }
    userPrompt = parsed.data.userPrompt;
    questionCount = parsed.data.questionCount;
    sourceType = parsed.data.sourceType;
    if (sourceType === "prompt" && evidenceEnabled) {
      const researchStarted = Date.now();
      try {
        const grounded = await researchGroundedTopic(parsed.data.content, userPrompt);
        extractedSource = grounded.extracted;
        groundedReferences = grounded.references;
        sourceText = grounded.extracted.fullText;
        sourceTitle = parsed.data.content.slice(0, 100);
        await recordGenerationTrace({
          stage: "web_research",
          durationMs: Date.now() - researchStarted,
          status: "success",
        });
      } catch (error) {
        const groundingCode =
          error instanceof WebGroundingError ? error.code : "provider_unavailable";
        await recordGenerationTrace({
          stage: "web_research",
          durationMs: Date.now() - researchStarted,
          status: "failed",
          errorCode:
            groundingCode === "insufficient_sources"
              ? "WEB_GROUNDING_INSUFFICIENT"
              : "WEB_GROUNDING_UNAVAILABLE",
        });
        const detail = error instanceof Error ? error.message : String(error);
        const insufficient = groundingCode === "insufficient_sources";
        return NextResponse.json(
          {
            error: insufficient
              ? "Couldn't ground this topic in enough authoritative sources. Upload notes or a PDF instead."
              : "Web-grounded topic generation is temporarily unavailable. Please retry later, or upload notes or a PDF.",
            detail,
          },
          { status: insufficient ? 422 : 503 }
        );
      }
    } else {
      extractedSource = await extractSource({
        type: "text",
        content: parsed.data.content,
        title: sourceType === "prompt" ? parsed.data.content.slice(0, 100) : "Pasted notes",
      });
      sourceText = extractedSource.fullText;
      sourceTitle =
        extractedSource.title ||
        (sourceType === "prompt" ? parsed.data.content.slice(0, 100) : "Pasted notes");
    }
  }

  if (sourceText.length < 20) {
    return NextResponse.json({ error: "Source text too short" }, { status: 400 });
  }

  // Trace each stage so the Vercel runtime logs show exactly how far a request
  // got before failing. Filter the logs by "[quizzes]" / "[expand]" / "[gemini]".
  const provider = process.env.LLM_PROVIDER ?? "hf";
  console.log(
    `[quizzes] start sourceType=${sourceType} chars=${sourceText.length} questions=${questionCount} provider=${provider}`
  );

  if (evidenceEnabled) {
    try {
      const quiz = await createEvidenceQuiz({
        userId,
        sourceKind:
          sourceType === "prompt" ? "web" : sourceType === "pdf" ? "pdf" : "notes",
        sourceType,
        sourceTitle,
        extracted: extractedSource,
        questionCount,
        userPrompt,
        references: groundedReferences,
        startedAt: new Date(reqStart),
      });
      return NextResponse.json(quiz, { status: 201 });
    } catch (error) {
      console.error("[quizzes] evidence pipeline failed:", error);
      const detail = error instanceof Error ? error.message : String(error);
      return NextResponse.json(
        {
          error: "Couldn't prepare the first verified questions. Please try again.",
          detail,
        },
        { status: 502 }
      );
    }
  }

  // For a bare topic ("prompt") — or thin notes/PDF text — first expand the
  // input into a detailed study briefing via Gemini, so the quiz generator has
  // rich, accurate grounding material. Best-effort: falls back to the raw text.
  const THIN_INPUT_CHARS = 500;
  let materialText = sourceText;
  if (sourceType === "prompt" || sourceText.length < THIN_INPUT_CHARS) {
    console.log("[quizzes] expanding topic via Gemini…");
    const expanded = await expandTopic(sourceText, userPrompt);
    materialText = expanded && expanded.length > sourceText.length ? expanded : sourceText;
    console.log(
      `[quizzes] expansion ${expanded ? `ok (${expanded.length} chars)` : "skipped/failed — using raw input"}`
    );
  }

  try {
    console.log(`[quizzes] generating with provider=${provider}…`);
    // Leave ~4s headroom under the 60s maxDuration for the DB write.
    const deadline = reqStart + 56_000;
    const { quiz: generatedRaw, provider: usedProvider } = await generateWithFallback(
      {
        sourceText: materialText,
        userPrompt,
        questionCount,
        seed: Math.floor(Math.random() * 1_000_000),
      },
      provider,
      deadline
    );
    const generated = shuffleQuizOptions(generatedRaw);
    if (usedProvider !== provider) {
      console.log(`[quizzes] primary "${provider}" unavailable — used fallback "${usedProvider}"`);
    }
    console.log(`[quizzes] generated ${generated.questions.length} questions, persisting…`);

    const quiz = await prisma.quiz.create({
      data: {
        userId,
        title: generated.title,
        sourceType,
        sourceSummary: sourceText.slice(0, 300),
        // The exact material the generator saw (post-expansion) — the verifier
        // must audit against this. verificationStatus defaults to "pending".
        groundingText: materialText.slice(0, 60000),
        // Provenance: which model + prompt version produced this quiz.
        generatorModel: usedProvider === "gemini" ? geminiModelName() : HF_MODEL_NAME,
        generatorPromptHash: GENERATOR_PROMPT_HASH,
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

    // Kick off cross-model verification immediately, in the background, in its
    // OWN function invocation (the /verify route has its own 60s budget) so it
    // overlaps with the user reading the first question instead of running as a
    // blocking step after generation. We keep the generation function alive only
    // long enough to deliver the trigger (~3s), not for the full verify; once the
    // verify route receives the request it runs to completion independently. The
    // player also fires this as a fallback — the verify route's lock is idempotent.
    const verifyUrl = `${req.nextUrl.origin}/api/quizzes/${quiz.id}/verify`;
    after(async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3_000);
      try {
        await fetch(verifyUrl, { method: "POST", signal: ctrl.signal });
      } catch {
        // Aborted once the request was sent, or a transient network error — the
        // verify route runs independently once received, and the player retries.
      } finally {
        clearTimeout(t);
      }
    });

    console.log(`[quizzes] done id=${quiz.id} (verification triggered in background)`);
    return NextResponse.json(quiz, { status: 201 });
  } catch (err) {
    console.error(`[quizzes] generation failed (provider=${provider}):`, err);
    // Surface the underlying reason so it's visible in the browser Network tab
    // and the on-screen error — makes misconfig/quota issues self-diagnosing.
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Couldn't generate the quiz. Please try again.", detail, provider },
      { status: 502 }
    );
  }
}

export async function GET() {
  const userId = await getCurrentUserId();

  const quizzes = await prisma.quiz.findMany({
    where: {
      userId,
      purpose: "standard",
      OR: [{ generationStatus: "legacy" }, { questionCount: { gt: 0 } }],
    },
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
