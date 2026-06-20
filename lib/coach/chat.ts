import { z } from "zod";
import { prisma } from "@/lib/db";
import { callStructuredWithFallback } from "@/lib/llm/structured";
import { normalizeEvidenceText, quoteExistsInChunk } from "@/lib/source/chunk";
import { retrieveChunks } from "@/lib/source/retrieval";
import { refreshCoachRecommendation } from "./planner";
import {
  toCoachActionDTO,
  type CoachActionDTO,
  type CoachActionType,
  type CoachEvidence,
} from "./types";

const answerSchema = z.object({
  answer: z.string().min(10),
  evidence: z
    .array(
      z.object({
        chunkId: z.string(),
        quote: z.string().min(12),
      })
    )
    .min(1)
    .max(3),
});

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          chunkId: { type: "string" },
          quote: { type: "string" },
        },
        required: ["chunkId", "quote"],
      },
    },
  },
  required: ["answer", "evidence"],
};

const STOP_WORDS = new Set([
  "what",
  "when",
  "where",
  "which",
  "that",
  "this",
  "with",
  "from",
  "have",
  "does",
  "explain",
  "about",
  "please",
  "could",
  "would",
  "should",
  "your",
  "into",
  "than",
  "and",
  "the",
  "for",
  "are",
  "was",
  "were",
  "how",
  "why",
  "can",
  "tell",
  "me",
]);

function contentTerms(message: string): string[] {
  return [
    ...new Set(
      normalizeEvidenceText(message)
        .split(" ")
        .filter((term) => term.length >= 3 && !STOP_WORDS.has(term))
    ),
  ];
}

export function sourceQuestionHasLexicalSupport(
  message: string,
  sourceTexts: string[]
): boolean {
  const terms = contentTerms(message);
  if (terms.length === 0) return false;
  const requiredHits = Math.min(2, terms.length);
  return sourceTexts.some((text) => {
    const tokens = new Set(normalizeEvidenceText(text).split(" "));
    const hits = terms.filter((term) => tokens.has(term)).length;
    return hits >= requiredHits;
  });
}

function scheduleQuestion(message: string): boolean {
  return /\b(exam date|target score|study plan|schedule|daily minutes|available days|progress|what should i do|next activity|due review)\b/i.test(
    message
  );
}

function requestedAction(message: string): CoachActionType | null {
  if (/\b(quiz me|give me a quiz|test me)\b/i.test(message)) return "quiz";
  if (/\b(review me|start a review|due review)\b/i.test(message)) return "review";
  if (/\b(teach me|make a lesson|lesson on)\b/i.test(message)) return "lesson";
  return null;
}

function requestedDateChange(message: string): Date | null {
  if (!/\b(change|move|set|update)\b.*\b(exam|date)\b/i.test(message)) {
    return null;
  }
  const match = message.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (!match) return null;
  const date = new Date(`${match[1]}T12:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function persistAssistantMessage(input: {
  threadId: string;
  content: string;
  citations?: CoachEvidence[];
  pendingPlanUpdate?: Record<string, unknown>;
  proposedActionId?: string | null;
}) {
  return prisma.coachMessage.create({
    data: {
      threadId: input.threadId,
      role: "assistant",
      content: input.content,
      citations: input.citations?.length
        ? JSON.stringify(input.citations)
        : null,
      pendingPlanUpdate: input.pendingPlanUpdate
        ? JSON.stringify(input.pendingPlanUpdate)
        : null,
      proposedActionId: input.proposedActionId,
    },
  });
}

async function proposeSourceRequest(
  planId: string,
  stateVersion: number,
  reason: string
): Promise<CoachActionDTO> {
  await prisma.coachAction.updateMany({
    where: { studyPlanId: planId, status: "proposed" },
    data: { status: "dismissed" },
  });
  const action = await prisma.coachAction.create({
    data: {
      studyPlanId: planId,
      type: "request_source",
      title: "Add a source for this topic",
      rationale: reason,
      estimatedMinutes: 3,
      conceptKeys: "[]",
      sourceDocumentIds: "[]",
      planStateVersion: stateVersion,
    },
  });
  return toCoachActionDTO(action);
}

export async function handleCoachChat(userId: string, message: string) {
  const plan = await prisma.studyPlan.findFirst({
    where: { userId, status: "active", activeKey: userId },
    include: {
      sources: { select: { sourceDocumentId: true } },
      threads: { take: 1 },
    },
  });
  if (!plan) throw new Error("NO_ACTIVE_PLAN");
  const thread =
    plan.threads[0] ??
    (await prisma.coachThread.create({ data: { studyPlanId: plan.id } }));
  await prisma.coachMessage.create({
    data: { threadId: thread.id, role: "user", content: message },
  });

  const dateChange = requestedDateChange(message);
  if (dateChange) {
    const pendingPlanUpdate = { examDate: dateChange.toISOString() };
    const text = `I can move your exam date to ${dateChange.toLocaleDateString(
      undefined,
      { month: "short", day: "numeric", year: "numeric" }
    )}. Confirm this change before I revise your plan.`;
    await persistAssistantMessage({
      threadId: thread.id,
      content: text,
      pendingPlanUpdate,
    });
    return {
      message: text,
      citations: [] as CoachEvidence[],
      proposedAction: null,
      pendingPlanUpdate,
    };
  }

  const requested = requestedAction(message);
  if (requested) {
    const action = await refreshCoachRecommendation(
      userId,
      plan.id,
      "chat_request",
      requested
    );
    const text = action
      ? `I prepared a ${action.type} proposal. Review why I chose it, then confirm before I generate anything.`
      : "The coach is currently running in shadow mode, so no activity was created.";
    await persistAssistantMessage({
      threadId: thread.id,
      content: text,
      proposedActionId: action?.id,
    });
    return {
      message: text,
      citations: [] as CoachEvidence[],
      proposedAction: action,
      pendingPlanUpdate: null,
    };
  }

  if (scheduleQuestion(message)) {
    const days = Math.max(
      0,
      Math.ceil((plan.examDate.getTime() - Date.now()) / 86_400_000)
    );
    const text = `Your ${plan.examTitle} plan has ${days} day${
      days === 1 ? "" : "s"
    } remaining, a ${plan.targetScore}% target, and ${plan.dailyMinutes} planned minutes per study day. Ask me to refresh if you want a new next-action recommendation.`;
    await persistAssistantMessage({ threadId: thread.id, content: text });
    return {
      message: text,
      citations: [] as CoachEvidence[],
      proposedAction: null,
      pendingPlanUpdate: null,
    };
  }

  const chunks = await prisma.sourceChunk.findMany({
    where: {
      sourceDocumentId: {
        in: plan.sources.map((source) => source.sourceDocumentId),
      },
    },
    include: {
      sourceDocument: { select: { title: true, originUrl: true } },
      references: {
        include: { sourceReference: true },
      },
    },
  });
  const selected = retrieveChunks(chunks, message, [], 3);
  const selectedById = new Map(
    selected.map((chunk) => [
      chunk.id,
      chunks.find((candidate) => candidate.id === chunk.id)!,
    ])
  );
  const relevant = sourceQuestionHasLexicalSupport(
    message,
    selected.map((chunk) => chunk.normalizedText || chunk.text)
  );
  if (!relevant) {
    const action = await proposeSourceRequest(
      plan.id,
      plan.stateVersion,
      "The attached study sources do not contain enough evidence to answer this question."
    );
    const text =
      "I can’t support that answer from the sources attached to your plan. Add notes, a PDF, or an approved grounded topic and I’ll answer from that material.";
    await persistAssistantMessage({
      threadId: thread.id,
      content: text,
      proposedActionId: action.id,
    });
    return {
      message: text,
      citations: [] as CoachEvidence[],
      proposedAction: action,
      pendingPlanUpdate: null,
    };
  }

  const started = Date.now();
  try {
    const response = await callStructuredWithFallback({
      system:
        "You are QuizCraft's source-grounded study coach. Answer only from the supplied source chunks. If the chunks do not support a claim, omit it. Return concise JSON with one to three exact supporting quotes. Never invent a URL or citation.",
      user: [
        `Learner question: ${message}`,
        "",
        ...selected.flatMap((chunk) => [
          `--- CHUNK ${chunk.id} ---`,
          chunk.text,
          "",
        ]),
      ].join("\n"),
      schema: RESPONSE_SCHEMA,
      maxTokens: 1200,
      timeoutMs: 18_000,
    });
    const answer = answerSchema.parse(response.raw);
    const citations: CoachEvidence[] = [];
    for (const evidence of answer.evidence) {
      const chunk = selectedById.get(evidence.chunkId);
      if (!chunk || !quoteExistsInChunk(evidence.quote, chunk.text)) {
        throw new Error("Coach citation did not match its source chunk.");
      }
      const reference = chunk.references[0]?.sourceReference;
      citations.push({
        quote: evidence.quote,
        sourceTitle: reference?.title ?? chunk.sourceDocument.title,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        section: chunk.section,
        url: reference?.url ?? chunk.sourceDocument.originUrl,
      });
    }
    await persistAssistantMessage({
      threadId: thread.id,
      content: answer.answer,
      citations,
    });
    await prisma.coachRun.create({
      data: {
        studyPlanId: plan.id,
        trigger: "chat_answer",
        candidateActions: "[]",
        provider: response.provider,
        model: response.model,
        durationMs: Date.now() - started,
        status: "success",
      },
    });
    return {
      message: answer.answer,
      citations,
      proposedAction: null,
      pendingPlanUpdate: null,
    };
  } catch {
    await prisma.coachRun.create({
      data: {
        studyPlanId: plan.id,
        trigger: "chat_answer",
        candidateActions: "[]",
        durationMs: Date.now() - started,
        status: "failed",
        errorCode: "GROUNDED_CHAT_FAILED",
      },
    });
    const text =
      "I found relevant source material, but I couldn’t produce a citation-valid answer right now. Please retry.";
    await persistAssistantMessage({ threadId: thread.id, content: text });
    return {
      message: text,
      citations: [] as CoachEvidence[],
      proposedAction: null,
      pendingPlanUpdate: null,
    };
  }
}
