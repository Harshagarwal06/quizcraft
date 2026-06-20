import { prisma } from "@/lib/db";
import type { ExtractedSource } from "@/lib/extract";
import { createEvidenceQuiz, createEvidenceReviewQuiz } from "@/lib/pipeline/quiz-pipeline";
import { generateCoachLesson } from "./lesson";
import {
  coachActionTypeSchema,
  parseStringArray,
  toCoachActionDTO,
} from "./types";

function parsePayload(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function sourceType(kind: string): "pdf" | "notes" | "prompt" {
  if (kind === "pdf") return "pdf";
  if (kind === "web") return "prompt";
  return "notes";
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/429|quota|rate limit/i.test(message)) return "PROVIDER_QUOTA";
  if (/timed out|timeout/i.test(message)) return "PROVIDER_TIMEOUT";
  if (/not due/i.test(message)) return "REVIEW_NOT_DUE";
  if (/source/i.test(message)) return "SOURCE_UNAVAILABLE";
  return "ACTION_FAILED";
}

export function actionConfirmationDisposition(input: {
  status: string;
  actionVersion: number;
  planVersion: number;
}): "ready" | "busy" | "confirmable" | "stale" | "rejected" {
  if (["ready", "completed"].includes(input.status)) return "ready";
  if (["approved", "preparing", "started"].includes(input.status)) return "busy";
  if (!["proposed", "failed"].includes(input.status)) return "rejected";
  if (input.actionVersion !== input.planVersion) return "stale";
  return "confirmable";
}

export async function confirmCoachAction(userId: string, actionId: string) {
  const action = await prisma.coachAction.findFirst({
    where: { id: actionId, studyPlan: { userId } },
    include: { studyPlan: true, lesson: true },
  });
  if (!action) throw new Error("ACTION_NOT_FOUND");
  const disposition = actionConfirmationDisposition({
    status: action.status,
    actionVersion: action.planStateVersion,
    planVersion: action.studyPlan.stateVersion,
  });
  if (disposition === "ready") {
    return { status: 200, action: toCoachActionDTO(action) };
  }
  if (disposition === "busy") {
    return { status: 202, action: toCoachActionDTO(action) };
  }
  if (disposition === "rejected") {
    throw new Error("ACTION_NOT_CONFIRMABLE");
  }
  if (disposition === "stale") {
    throw new Error("STALE_ACTION");
  }

  const claim = await prisma.coachAction.updateMany({
    where: {
      id: action.id,
      status: { in: ["proposed", "failed"] },
      planStateVersion: action.studyPlan.stateVersion,
    },
    data: {
      status: "preparing",
      approvedAt: action.approvedAt ?? new Date(),
      startedAt: new Date(),
      errorCode: null,
      errorMessage: null,
    },
  });
  if (claim.count === 0) {
    const current = await prisma.coachAction.findUniqueOrThrow({
      where: { id: action.id },
    });
    return { status: 202, action: toCoachActionDTO(current) };
  }

  try {
    const type = coachActionTypeSchema.parse(action.type);
    const conceptKeys = parseStringArray(action.conceptKeys);
    const sourceDocumentIds = parseStringArray(action.sourceDocumentIds);
    const payload = parsePayload(action.payload);
    let readyHref: string | null = null;
    let generatedQuizId: string | null = null;

    if (type === "lesson") {
      const lesson =
        action.lesson ?? (await generateCoachLesson(action.id));
      readyHref = `/coach/lessons/${lesson.id}`;
    } else if (type === "quiz") {
      const source = await prisma.sourceDocument.findFirst({
        where: {
          id: sourceDocumentIds[0],
          userId,
          studyPlanLinks: { some: { studyPlanId: action.studyPlanId } },
        },
        include: { chunks: { orderBy: { ordinal: "asc" } } },
      });
      if (!source) throw new Error("Quiz source is unavailable.");
      const extracted: ExtractedSource = {
        title: source.title,
        fullText: source.fullText,
        pages: source.chunks.map((chunk) => ({
          pageNumber: chunk.pageStart,
          section: chunk.section ?? undefined,
          text: chunk.text,
        })),
        metadata: { reusedSourceDocumentId: source.id },
      };
      const labels = await prisma.planConcept.findMany({
        where: {
          studyPlanId: action.studyPlanId,
          conceptKey: { in: conceptKeys },
        },
        select: { label: true },
      });
      const quiz = await createEvidenceQuiz({
        userId,
        sourceKind: source.kind as "pdf" | "notes" | "web",
        sourceType: sourceType(source.kind),
        sourceTitle: source.title,
        extracted,
        questionCount:
          typeof payload.questionCount === "number"
            ? Math.min(15, Math.max(3, payload.questionCount))
            : 6,
        userPrompt:
          labels.length > 0
            ? `Focus on these study-plan concepts: ${labels
                .map((item) => item.label)
                .join(", ")}.`
            : "Create a balanced progress-check quiz.",
        originUrl: source.originUrl ?? undefined,
      });
      generatedQuizId = quiz.id;
      readyHref = `/quiz/${quiz.id}`;
    } else if (type === "review") {
      const sourceQuizId =
        typeof payload.sourceQuizId === "string"
          ? payload.sourceQuizId
          : null;
      if (!sourceQuizId || conceptKeys.length === 0 || conceptKeys.length > 3) {
        throw new Error("Review action is invalid.");
      }
      const due = await prisma.conceptReview.findMany({
        where: {
          userId,
          sourceQuizId,
          conceptKey: { in: conceptKeys },
          stage: { lt: 6 },
          dueAt: { lte: new Date() },
        },
      });
      if (due.length !== new Set(conceptKeys).size) {
        throw new Error("One or more requested concepts are not due.");
      }
      const sourceQuiz = await prisma.quiz.findFirst({
        where: {
          id: sourceQuizId,
          userId,
          purpose: "standard",
          sourceDocumentId: { in: sourceDocumentIds },
        },
        select: {
          id: true,
          title: true,
          sourceType: true,
          sourceDocumentId: true,
        },
      });
      if (!sourceQuiz?.sourceDocumentId) {
        throw new Error("Review source is unavailable.");
      }
      const review = await createEvidenceReviewQuiz({
        userId,
        sourceQuizId,
        sourceDocumentId: sourceQuiz.sourceDocumentId,
        sourceTitle: sourceQuiz.title,
        sourceType: sourceQuiz.sourceType,
        concepts: due.map((concept) => ({
          key: concept.conceptKey,
          label: concept.label,
        })),
      });
      generatedQuizId = review.id;
      readyHref = `/quiz/${review.id}`;
    } else if (type === "request_source") {
      readyHref = "/generate";
    } else {
      readyHref = "/dashboard";
    }

    const completed = await prisma.coachAction.update({
      where: { id: action.id },
      data: {
        status: type === "rest" ? "completed" : "ready",
        generatedQuizId,
        readyHref,
        completedAt: type === "rest" ? new Date() : null,
      },
    });
    return { status: 200, action: toCoachActionDTO(completed) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await prisma.coachAction.update({
      where: { id: action.id },
      data: {
        status: "failed",
        errorCode: errorCode(error),
        errorMessage: message.slice(0, 500),
      },
    });
    return { status: 502, action: toCoachActionDTO(failed) };
  }
}
