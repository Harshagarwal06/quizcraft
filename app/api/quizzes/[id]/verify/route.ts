export const dynamic = "force-dynamic";
// A full verify + repair round (verifier call, optional regeneration, re-verify)
// can take ~40-55s; give it its own function budget separate from generation.
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { GeneratedQuestion } from "@/lib/llm/types";
import { selectVerifier } from "@/lib/llm/verify";
import { VERIFIER_PROMPT_HASH } from "@/lib/llm/verify/prompt";
import { verifyAndRepair } from "@/lib/llm/verify/repair";

// Leave headroom under maxDuration for the final DB writes.
const DEADLINE_MS = 52_000;

type OptionId = "A" | "B" | "C" | "D";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await getCurrentUserId();

  const quiz = await prisma.quiz.findFirst({
    where: { id, userId },
    select: { id: true, groundingText: true, verificationStatus: true },
  });
  if (!quiz) return NextResponse.json({ error: "Quiz not found" }, { status: 404 });

  // Idempotent lock: only one invocation may move pending|failed → verifying.
  const lock = await prisma.quiz.updateMany({
    where: { id, userId, verificationStatus: { in: ["pending", "failed"] } },
    data: { verificationStatus: "verifying" },
  });
  if (lock.count === 0) {
    // Someone else already handled it (or is mid-flight).
    const status = quiz.verificationStatus;
    return NextResponse.json({ status }, { status: status === "verifying" ? 202 : 200 });
  }

  // No usable verifier key, or nothing to audit against → skip gracefully.
  const verifier = selectVerifier();
  const material = quiz.groundingText ?? "";
  if (!verifier || material.trim().length < 20) {
    await prisma.quiz.update({
      where: { id },
      data: { verificationStatus: "skipped", verifiedAt: new Date() },
    });
    console.log(`[verify] quiz=${id} skipped (verifier=${!!verifier} materialChars=${material.length})`);
    return NextResponse.json({ status: "skipped" });
  }

  try {
    const rows = await prisma.question.findMany({
      where: { quizId: id },
      orderBy: { order: "asc" },
      select: {
        id: true,
        stem: true,
        options: true,
        correctOption: true,
        explanation: true,
        difficulty: true,
        topic: true,
      },
    });

    const questions: GeneratedQuestion[] = rows.map((r) => ({
      stem: r.stem,
      options: JSON.parse(r.options) as { id: OptionId; text: string }[],
      correctOptionId: r.correctOption as OptionId,
      explanation: r.explanation,
      difficulty: r.difficulty as GeneratedQuestion["difficulty"],
      topic: r.topic,
    }));

    const result = await verifyAndRepair({
      material,
      questions,
      verifier,
      deadline: Date.now() + DEADLINE_MS,
    });

    // Persist per-question content (key fixes / replacements) + verdicts, then
    // the quiz-level summary — all in one transaction.
    const updates = result.questions.map((rq, i) =>
      prisma.question.update({
        where: { id: rows[i].id },
        data: {
          stem: rq.question.stem,
          options: JSON.stringify(rq.question.options),
          correctOption: rq.question.correctOptionId,
          explanation: rq.question.explanation,
          difficulty: rq.question.difficulty,
          topic: rq.question.topic,
          verdict: rq.verdict,
          verificationDetail: JSON.stringify(rq.detail),
        },
      })
    );

    await prisma.$transaction([
      ...updates,
      prisma.quiz.update({
        where: { id },
        data: {
          verificationStatus: "verified",
          verifiedAt: new Date(),
          verifierModel: verifier.model,
          verifierPromptHash: VERIFIER_PROMPT_HASH,
          verificationSummary: JSON.stringify(result.summary),
        },
      }),
    ]);

    const s = result.summary;
    console.log(
      `[verify] quiz=${id} verifier=${verifier.provider}:${verifier.model} n=${s.total} failedInitial=${s.failedInitial} repaired=${s.repaired} flagged=${s.flagged}`
    );

    return NextResponse.json({ status: "verified", summary: s });
  } catch (err) {
    console.error(`[verify] quiz=${id} failed:`, err);
    // Reset so a later request can retry.
    await prisma.quiz
      .update({ where: { id }, data: { verificationStatus: "failed" } })
      .catch(() => {});
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Verification failed. Please try again.", detail },
      { status: 502 }
    );
  }
}
