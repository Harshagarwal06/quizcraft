import { prisma } from "@/lib/db";
import type { ExtractedSource } from "@/lib/extract";
import { normalizeConceptKey } from "@/lib/mastery";
import { buildQuizBlueprint } from "@/lib/llm/blueprint";
import type { GeneratedQuestion } from "@/lib/llm/types";
import { selectVerifier, verifyQuestions } from "@/lib/llm/verify";
import { VERIFIER_PROMPT_HASH } from "@/lib/llm/verify/prompt";
import type { QuestionVerdict } from "@/lib/llm/verify/types";
import {
  EVIDENCE_GENERATOR_PROMPT_HASH,
  generateEvidenceBatch,
  type EvidenceBlueprintItem,
} from "./evidence-generation";
import { recordGenerationTrace } from "./trace";
import {
  persistSourceDocument,
  type GroundedReference,
} from "@/lib/source/store";
import { retrieveChunks } from "@/lib/source/retrieval";

const BATCH_SIZE = 3;

type SourceKind = "pdf" | "notes" | "web";

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function isPass(verdict: QuestionVerdict): boolean {
  return (
    verdict.complete !== false &&
    verdict.grounded &&
    verdict.answerSupported &&
    verdict.uniqueAnswer &&
    verdict.distractorsValid &&
    verdict.evidenceValid
  );
}

function auditQuestion(
  question: GeneratedQuestion,
  item: EvidenceBlueprintItem
) {
  const chunks = new Map(item.chunks.map((chunk) => [chunk.id, chunk]));
  return {
    stem: question.stem,
    options: question.options,
    correctOptionId: question.correctOptionId,
    evidence: (question.evidence ?? []).map((evidence) => ({
      chunkId: evidence.chunkId,
      quote: evidence.quote,
      chunkText: chunks.get(evidence.chunkId)?.text ?? "",
    })),
  };
}

async function verifyGenerated(
  questions: GeneratedQuestion[],
  items: EvidenceBlueprintItem[]
): Promise<{ verdicts: QuestionVerdict[]; verifierModel: string }> {
  const verifier = selectVerifier();
  if (!verifier) {
    throw new Error("A verifier provider is required for evidence-backed quizzes.");
  }
  const itemById = new Map(items.map((item) => [item.id, item]));
  const audits = questions.map((question) => {
    const item = itemById.get(question.blueprintItemId ?? "");
    if (!item) throw new Error("Generated question lost its blueprint item.");
    return auditQuestion(question, item);
  });
  return {
    verdicts: await verifyQuestions("", audits, verifier),
    verifierModel: verifier.model,
  };
}

async function createQuestionsForBatch(opts: {
  items: EvidenceBlueprintItem[];
  previousStems: string[];
}): Promise<{
  accepted: {
    question: GeneratedQuestion;
    verdict: "pass" | "repaired";
    detail: QuestionVerdict;
  }[];
  failedItemIds: string[];
  unverifiedItemIds: string[];
  provider: string;
  model: string;
  verifierModel: string;
  retryCount: number;
}> {
  const generated = await generateEvidenceBatch(opts);
  const firstAudit = await verifyGenerated(generated.questions, opts.items);
  const accepted: {
    question: GeneratedQuestion;
    verdict: "pass" | "repaired";
    detail: QuestionVerdict;
  }[] = [];
  const failedItems: EvidenceBlueprintItem[] = [];
  const failureByItemId = new Map<string, "FLAGGED" | "UNVERIFIED">();

  generated.questions.forEach((question, index) => {
    const verdict = firstAudit.verdicts[index];
    if (isPass(verdict)) {
      accepted.push({ question, verdict: "pass", detail: verdict });
    } else {
      const item = opts.items.find(
        (candidate) => candidate.id === question.blueprintItemId
      );
      if (item) {
        failedItems.push(item);
        failureByItemId.set(
          item.id,
          verdict.complete === false ? "UNVERIFIED" : "FLAGGED"
        );
      }
    }
  });

  let verifierModel = firstAudit.verifierModel;
  if (failedItems.length > 0) {
    try {
      const replacement = await generateEvidenceBatch({
        items: failedItems,
        previousStems: [
          ...opts.previousStems,
          ...generated.questions.map((question) => question.stem),
        ],
      });
      const replacementAudit = await verifyGenerated(
        replacement.questions,
        failedItems
      );
      verifierModel = replacementAudit.verifierModel;
      replacement.questions.forEach((question, index) => {
        const verdict = replacementAudit.verdicts[index];
        if (isPass(verdict)) {
          accepted.push({ question, verdict: "repaired", detail: verdict });
          failureByItemId.delete(question.blueprintItemId ?? "");
        } else if (question.blueprintItemId) {
          failureByItemId.set(
            question.blueprintItemId,
            verdict.complete === false ? "UNVERIFIED" : "FLAGGED"
          );
        }
      });
    } catch (error) {
      console.warn("[pipeline] focused evidence repair failed:", error);
    }
  }

  const acceptedIds = new Set(
    accepted.map((result) => result.question.blueprintItemId)
  );
  return {
    accepted,
    failedItemIds: opts.items
      .map((item) => item.id)
      .filter((id) => !acceptedIds.has(id)),
    unverifiedItemIds: [...failureByItemId.entries()]
      .filter(([, code]) => code === "UNVERIFIED")
      .map(([id]) => id),
    provider: generated.provider,
    model: generated.model,
    verifierModel,
    retryCount: generated.retryCount,
  };
}

export async function createEvidenceQuiz(opts: {
  userId: string;
  sourceKind: SourceKind;
  sourceType: "pdf" | "notes" | "prompt";
  sourceTitle: string;
  extracted: ExtractedSource;
  questionCount: number;
  userPrompt?: string;
  originUrl?: string;
  references?: GroundedReference[];
  startedAt?: Date;
}): Promise<{ id: string; title: string; questionCount: number }> {
  const extractionStarted = Date.now();
  const sourceDocument = await persistSourceDocument({
    userId: opts.userId,
    kind: opts.sourceKind,
    title: opts.sourceTitle,
    extracted: opts.extracted,
    originUrl: opts.originUrl,
    references: opts.references,
  });
  await recordGenerationTrace({
    stage: "source_extraction",
    durationMs: Date.now() - extractionStarted,
    status: "success",
  });

  const blueprintStarted = Date.now();
  const blueprint = await buildQuizBlueprint({
    chunks: sourceDocument.chunks,
    questionCount: opts.questionCount,
    userPrompt: opts.userPrompt,
  });

  const batchCount = Math.ceil(opts.questionCount / BATCH_SIZE);
  const quiz = await prisma.quiz.create({
    data: {
      userId: opts.userId,
      title: blueprint.title,
      sourceType: opts.sourceType,
      sourceSummary: opts.extracted.fullText.slice(0, 300),
      groundingText: opts.extracted.fullText.slice(0, 60000),
      sourceDocumentId: sourceDocument.id,
      generationStatus: "preparing",
      targetQuestionCount: opts.questionCount,
      questionCount: 0,
      createdAt: opts.startedAt,
      generatorModel: blueprint.model,
      generatorPromptHash: EVIDENCE_GENERATOR_PROMPT_HASH,
      blueprintItems: {
        create: blueprint.items.map((item) => ({
          slot: item.slot,
          conceptKey: item.conceptKey,
          topic: item.topic,
          objective: item.objective,
          difficulty: item.difficulty,
          skillType: item.skillType,
          retrievalQuery: item.retrievalQuery,
          requiredFacts: JSON.stringify(item.requiredFacts),
          seedChunkIds: JSON.stringify(item.seedChunkIds),
          batchIndex: item.batchIndex,
        })),
      },
      generationBatches: {
        create: Array.from({ length: batchCount }, (_, batchIndex) => ({
          batchIndex,
        })),
      },
    },
    select: { id: true, title: true },
  });
  await recordGenerationTrace({
    quizId: quiz.id,
    stage: "blueprint",
    provider: blueprint.provider,
    model: blueprint.model,
    durationMs: Date.now() - blueprintStarted,
    questionCount: opts.questionCount,
    status: "success",
  });

  const first = await processEvidenceBatch(quiz.id, 0);
  if (first.status !== "ready") {
    throw new Error(
      first.error ?? "The first verified question batch could not be prepared."
    );
  }
  return {
    id: quiz.id,
    title: quiz.title,
    questionCount: first.readyCount,
  };
}

export async function createEvidenceReviewQuiz(opts: {
  userId: string;
  sourceQuizId: string;
  sourceDocumentId: string;
  sourceTitle: string;
  sourceType: string;
  concepts: { key: string; label: string }[];
}): Promise<{ id: string }> {
  const sourceDocument = await prisma.sourceDocument.findFirst({
    where: { id: opts.sourceDocumentId, userId: opts.userId },
    include: { chunks: { orderBy: { ordinal: "asc" } } },
  });
  if (!sourceDocument) {
    throw new Error("The original evidence source is unavailable.");
  }
  const planned = opts.concepts.flatMap((concept) =>
    (["medium", "hard"] as const).map((difficulty, index) => {
      const slot = opts.concepts.indexOf(concept) * 2 + index;
      const seed = retrieveChunks(
        sourceDocument.chunks,
        `${concept.label} ${difficulty} university exam`,
        [],
        1
      );
      return {
        slot,
        concept,
        difficulty,
        seedChunkIds: seed.map((chunk) => chunk.id),
      };
    })
  );
  const quiz = await prisma.quiz.create({
    data: {
      userId: opts.userId,
      title: `Review: ${opts.sourceTitle}`,
      sourceType: opts.sourceType,
      sourceSummary: sourceDocument.fullText.slice(0, 300),
      groundingText: sourceDocument.fullText.slice(0, 60000),
      purpose: "review",
      sourceQuizId: opts.sourceQuizId,
      sourceDocumentId: sourceDocument.id,
      generationStatus: "preparing",
      targetQuestionCount: planned.length,
      questionCount: 0,
      generatorPromptHash: EVIDENCE_GENERATOR_PROMPT_HASH,
      blueprintItems: {
        create: planned.map((item) => ({
          slot: item.slot,
          conceptKey: item.concept.key,
          topic: item.concept.label,
          objective: `Apply ${item.concept.label} in a fresh ${item.difficulty} question`,
          difficulty: item.difficulty,
          skillType: item.difficulty === "medium" ? "application" : "analysis",
          retrievalQuery: item.concept.label,
          requiredFacts: JSON.stringify([item.concept.label]),
          seedChunkIds: JSON.stringify(item.seedChunkIds),
          batchIndex: Math.floor(item.slot / BATCH_SIZE),
        })),
      },
      generationBatches: {
        create: Array.from(
          { length: Math.ceil(planned.length / BATCH_SIZE) },
          (_, batchIndex) => ({ batchIndex })
        ),
      },
    },
    select: { id: true },
  });
  const first = await processEvidenceBatch(quiz.id, 0);
  if (first.status !== "ready") {
    throw new Error(first.error ?? "The first review batch could not be verified.");
  }
  return quiz;
}

export async function processEvidenceBatch(
  quizId: string,
  batchIndex: number
): Promise<{
  status: "ready" | "failed" | "busy";
  readyCount: number;
  targetCount: number;
  error?: string;
}> {
  const batch = await prisma.quizGenerationBatch.findUnique({
    where: { quizId_batchIndex: { quizId, batchIndex } },
  });
  if (!batch) {
    return { status: "failed", readyCount: 0, targetCount: 0, error: "Batch not found." };
  }
  if (batch.status === "ready") {
    const quiz = await prisma.quiz.findUniqueOrThrow({
      where: { id: quizId },
      select: { questionCount: true, targetQuestionCount: true },
    });
    return {
      status: "ready",
      readyCount: quiz.questionCount,
      targetCount: quiz.targetQuestionCount ?? quiz.questionCount,
    };
  }
  const lock = await prisma.quizGenerationBatch.updateMany({
    where: {
      id: batch.id,
      status: { in: ["pending", "failed"] },
    },
    data: {
      status: "generating",
      attemptCount: { increment: 1 },
      startedAt: new Date(),
      errorCode: null,
      errorMessage: null,
    },
  });
  if (lock.count === 0) {
    const quiz = await prisma.quiz.findUniqueOrThrow({
      where: { id: quizId },
      select: { questionCount: true, targetQuestionCount: true },
    });
    return {
      status: "busy",
      readyCount: quiz.questionCount,
      targetCount: quiz.targetQuestionCount ?? quiz.questionCount,
    };
  }

  const started = Date.now();
  try {
    const quiz = await prisma.quiz.findUniqueOrThrow({
      where: { id: quizId },
      include: {
        sourceDocument: {
          include: { chunks: { orderBy: { ordinal: "asc" } } },
        },
        blueprintItems: {
          where: { batchIndex, status: { not: "ready" } },
          orderBy: { slot: "asc" },
        },
        questions: { select: { stem: true } },
      },
    });
    if (!quiz.sourceDocument) throw new Error("Quiz source document is missing.");

    const items: EvidenceBlueprintItem[] = quiz.blueprintItems.map((item) => {
      const requiredFacts = parseStringArray(item.requiredFacts);
      const seedChunkIds = parseStringArray(item.seedChunkIds);
      const query = [
        item.topic,
        item.objective,
        requiredFacts.join(" "),
        item.retrievalQuery,
      ].join(" ");
      return {
        id: item.id,
        slot: item.slot,
        topic: item.topic,
        objective: item.objective,
        difficulty: item.difficulty as "easy" | "medium" | "hard",
        skillType: item.skillType,
        retrievalQuery: item.retrievalQuery,
        requiredFacts,
        chunks: retrieveChunks(
          quiz.sourceDocument!.chunks,
          query,
          seedChunkIds,
          3
        ),
      };
    });

    await prisma.$transaction([
      prisma.quizGenerationBatch.update({
        where: { id: batch.id },
        data: { status: "verifying" },
      }),
      ...items.map((item) =>
        prisma.quizBlueprintItem.update({
          where: { id: item.id },
          data: { status: "generating", failureCode: null },
        })
      ),
    ]);

    const relatedStems =
      quiz.purpose === "review" && quiz.sourceQuizId
        ? await prisma.question.findMany({
            where: {
              OR: [
                { quizId: quiz.sourceQuizId },
                { quiz: { sourceQuizId: quiz.sourceQuizId, purpose: "review" } },
              ],
            },
            select: { stem: true },
            take: 150,
          })
        : [];
    const result = await createQuestionsForBatch({
      items,
      previousStems: [
        ...quiz.questions.map((question) => question.stem),
        ...relatedStems.map((question) => question.stem),
      ],
    });
    const acceptedById = new Map(
      result.accepted.map((accepted) => [
        accepted.question.blueprintItemId as string,
        accepted,
      ])
    );

    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        const accepted = acceptedById.get(item.id);
        if (!accepted) {
          await tx.quizBlueprintItem.update({
            where: { id: item.id },
            data: {
              status: "failed",
              failureCode: result.unverifiedItemIds.includes(item.id)
                ? "UNVERIFIED"
                : "FLAGGED",
            },
          });
          continue;
        }
        const question = accepted.question;
        await tx.question.create({
          data: {
            quizId,
            blueprintItemId: item.id,
            stem: question.stem,
            options: JSON.stringify(question.options),
            correctOption: question.correctOptionId,
            explanation: question.explanation,
            optionExplanations: JSON.stringify(question.optionExplanations),
            difficulty: item.difficulty,
            topic: item.topic,
            order: item.slot,
            reviewConceptKey:
              quiz.purpose === "review" ? normalizeConceptKey(item.topic) : null,
            verdict: accepted.verdict,
            evidenceStatus: "valid",
            verificationDetail: JSON.stringify(accepted.detail),
            evidence: {
              create: (question.evidence ?? []).map((evidence, displayOrder) => ({
                sourceChunkId: evidence.chunkId,
                quote: evidence.quote,
                displayOrder,
              })),
            },
          },
        });
        await tx.quizBlueprintItem.update({
          where: { id: item.id },
          data: { status: "ready", failureCode: null },
        });
      }

      const failed = result.failedItemIds.length;
      await tx.quizGenerationBatch.update({
        where: { id: batch.id },
        data: {
          status: failed === 0 ? "ready" : "failed",
          errorCode:
            failed === 0
              ? null
              : result.unverifiedItemIds.length > 0
                ? "QUESTION_UNVERIFIED"
                : "QUESTION_VERIFICATION_FAILED",
          errorMessage:
            failed === 0
              ? null
              : `${failed} blueprint item(s) could not be verified; ${result.unverifiedItemIds.length} had incomplete verifier results.`,
          completedAt: new Date(),
        },
      });
    });

    const [readyCount, batches, questionVerdicts, failedItemsNow] = await Promise.all([
      prisma.question.count({
        where: {
          quizId,
          verdict: { in: ["pass", "repaired"] },
          evidenceStatus: "valid",
        },
      }),
      prisma.quizGenerationBatch.findMany({ where: { quizId } }),
      prisma.question.findMany({
        where: { quizId },
        select: { verdict: true },
      }),
      prisma.quizBlueprintItem.findMany({
        where: { quizId, status: "failed" },
        select: { failureCode: true },
      }),
    ]);
    const unverifiedSlots = failedItemsNow.filter(
      (item) => item.failureCode === "UNVERIFIED"
    ).length;
    const flaggedSlots = failedItemsNow.length - unverifiedSlots;
    const allReady = batches.every((item) => item.status === "ready");
    const anyFailed = batches.some((item) => item.status === "failed");
    const firstReady =
      batches.find((item) => item.batchIndex === 0)?.status === "ready";
    const targetCount = quiz.targetQuestionCount ?? items.length;
    const status =
      allReady
        ? "complete"
        : firstReady && anyFailed
          ? "partial"
          : firstReady
            ? "first_batch_ready"
            : "failed";
    const summary = {
      total: readyCount + failedItemsNow.length,
      passedInitial: questionVerdicts.filter((item) => item.verdict === "pass")
        .length,
      failedInitial:
        questionVerdicts.filter((item) => item.verdict === "repaired").length +
        failedItemsNow.length,
      repaired: questionVerdicts.filter((item) => item.verdict === "repaired")
        .length,
      flagged: flaggedSlots,
      unverified: unverifiedSlots,
    };
    await prisma.quiz.update({
      where: { id: quizId },
      data: {
        questionCount: readyCount,
        generationStatus: status,
        firstBatchReadyAt:
          batchIndex === 0 && result.failedItemIds.length === 0
            ? new Date()
            : quiz.firstBatchReadyAt,
        generationError:
          result.failedItemIds.length > 0
            ? `${result.failedItemIds.length} question(s) need retry.`
            : null,
        generatorModel: result.model,
        generatorPromptHash: EVIDENCE_GENERATOR_PROMPT_HASH,
        verificationStatus: firstReady ? "verified" : "failed",
        verifiedAt: firstReady ? new Date() : null,
        verifierModel: result.verifierModel,
        verifierPromptHash: VERIFIER_PROMPT_HASH,
        verificationSummary: JSON.stringify(summary),
      },
    });
    await recordGenerationTrace({
      quizId,
      stage: "batch_generation",
      batchIndex,
      provider: result.provider,
      model: result.model,
      durationMs: Date.now() - started,
      questionCount: items.length,
      retryCount: result.retryCount,
      status: result.failedItemIds.length === 0 ? "success" : "failed",
      errorCode:
        result.failedItemIds.length === 0
          ? undefined
          : "QUESTION_VERIFICATION_FAILED",
    });

    return {
      status: result.failedItemIds.length === 0 ? "ready" : "failed",
      readyCount,
      targetCount,
      error:
        result.failedItemIds.length === 0
          ? undefined
          : `${result.failedItemIds.length} question(s) could not be verified.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.$transaction([
      prisma.quizGenerationBatch.update({
        where: { id: batch.id },
        data: {
          status: "failed",
          errorCode: "BATCH_FAILED",
          errorMessage: message.slice(0, 1000),
          completedAt: new Date(),
        },
      }),
      prisma.quiz.update({
        where: { id: quizId },
        data: {
          generationStatus: batchIndex === 0 ? "failed" : "partial",
          generationError: message.slice(0, 1000),
        },
      }),
    ]);
    await recordGenerationTrace({
      quizId,
      stage: "batch_generation",
      batchIndex,
      durationMs: Date.now() - started,
      status: "failed",
      errorCode: "BATCH_FAILED",
    });
    const quiz = await prisma.quiz.findUniqueOrThrow({
      where: { id: quizId },
      select: { questionCount: true, targetQuestionCount: true },
    });
    return {
      status: "failed",
      readyCount: quiz.questionCount,
      targetCount: quiz.targetQuestionCount ?? quiz.questionCount,
      error: message,
    };
  }
}

export async function processNextEvidenceBatch(
  quizId: string,
  retryFailed = false
) {
  const batch = await prisma.quizGenerationBatch.findFirst({
    where: {
      quizId,
      status: retryFailed ? "failed" : "pending",
    },
    orderBy: { batchIndex: "asc" },
  });
  if (!batch) {
    const quiz = await prisma.quiz.findUniqueOrThrow({
      where: { id: quizId },
      select: { questionCount: true, targetQuestionCount: true },
    });
    return {
      status: "ready" as const,
      readyCount: quiz.questionCount,
      targetCount: quiz.targetQuestionCount ?? quiz.questionCount,
    };
  }
  return processEvidenceBatch(quizId, batch.batchIndex);
}
