import { z } from "zod";
import { prisma } from "@/lib/db";
import { callStructuredWithFallback } from "@/lib/llm/structured";
import { buildPlannerState } from "./state";
import {
  coachActionTypeSchema,
  isAllowedCoachTool,
  toCoachActionDTO,
  type CoachActionDTO,
  type CoachActionType,
  type CoachCandidate,
} from "./types";

const plannerSelectionSchema = z.object({
  candidateId: z.string().min(1),
  reason: z.string().min(5).max(300),
});

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    candidateId: { type: "string" },
    reason: { type: "string" },
  },
  required: ["candidateId", "reason"],
};

function fallbackCandidate(planId: string): CoachCandidate {
  return {
    id: `rest:${planId}`,
    type: "rest",
    tool: null,
    title: "Check your study plan",
    reason:
      "No new activity is eligible right now. Review your schedule or return when the next review is due.",
    estimatedMinutes: 2,
    conceptKeys: [],
    sourceDocumentIds: [],
    score: 0,
  };
}

function plannerPrompt(candidates: CoachCandidate[], context: {
  examTitle: string;
  examDate: Date;
  targetScore: number;
  dailyMinutes: number;
}) {
  return [
    `Exam: ${context.examTitle}`,
    `Exam date: ${context.examDate.toISOString().slice(0, 10)}`,
    `Target score: ${context.targetScore}%`,
    `Daily study budget: ${context.dailyMinutes} minutes`,
    "",
    "Choose exactly one candidate from this allowlist. Never invent an action, tool, concept, source, or URL.",
    JSON.stringify(
      candidates.map((candidate) => ({
        id: candidate.id,
        type: candidate.type,
        tool: candidate.tool,
        title: candidate.title,
        reason: candidate.reason,
        minutes: candidate.estimatedMinutes,
        score: candidate.score,
      }))
    ),
  ].join("\n");
}

export async function refreshCoachRecommendation(
  userId: string,
  studyPlanId: string,
  trigger: string,
  preferredType?: CoachActionType
): Promise<CoachActionDTO | null> {
  if (process.env.COACH_AGENT_ENABLED === "false") return null;

  const existingWork = await prisma.coachAction.findFirst({
    where: {
      studyPlanId,
      studyPlan: { userId },
      status: { in: ["approved", "preparing", "ready"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existingWork) return toCoachActionDTO(existingWork);

  const started = Date.now();
  const state = await buildPlannerState(userId, studyPlanId);
  await prisma.coachAction.updateMany({
    where: { studyPlanId, status: "proposed" },
    data: { status: "dismissed" },
  });

  let candidates = state.candidates;
  if (preferredType) {
    const preferred = candidates.filter(
      (candidate) => candidate.type === preferredType
    );
    if (preferred.length > 0) candidates = preferred;
  }
  if (candidates.length === 0) candidates = [fallbackCandidate(studyPlanId)];
  for (const candidate of candidates) {
    if (candidate.tool && !isAllowedCoachTool(candidate.tool)) {
      throw new Error(`Coach policy rejected tool ${candidate.tool}`);
    }
    coachActionTypeSchema.parse(candidate.type);
  }

  let selected = candidates[0];
  let provider: string | undefined;
  let model: string | undefined;
  let status = "fallback";
  let errorCode: string | undefined;
  let policyRejected = false;

  if (process.env.COACH_AGENT_SHADOW !== "true" && candidates.length > 1) {
    try {
      const response = await callStructuredWithFallback({
        system:
          "You are QuizCraft's bounded study-planning selector. You may select only one provided candidate ID. Do not invent tools or actions. Prefer due reviews, then remediation, then unseen important material, then quizzes.",
        user: plannerPrompt(candidates, state.plan),
        schema: RESPONSE_SCHEMA,
        maxTokens: 300,
        timeoutMs: 10_000,
      });
      provider = response.provider;
      model = response.model;
      const parsed = plannerSelectionSchema.parse(response.raw);
      const chosen = candidates.find(
        (candidate) => candidate.id === parsed.candidateId
      );
      if (!chosen) {
        policyRejected = true;
        errorCode = "PLANNER_SELECTION_REJECTED";
      } else {
        selected = chosen;
        status = "success";
      }
    } catch (error) {
      status = "fallback";
      errorCode =
        error instanceof Error &&
        /No configured structured-output provider/.test(error.message)
          ? "PLANNER_PROVIDER_UNAVAILABLE"
          : "PLANNER_FAILED";
    }
  }

  if (process.env.COACH_AGENT_SHADOW === "true") {
    await prisma.coachRun.create({
      data: {
        studyPlanId,
        trigger,
        candidateActions: JSON.stringify(candidates),
        selectedActionType: selected.type,
        provider,
        model,
        durationMs: Date.now() - started,
        status: "shadow",
        policyRejected,
        errorCode,
      },
    });
    return null;
  }

  const action = await prisma.coachAction.create({
    data: {
      studyPlanId,
      type: selected.type,
      status: "proposed",
      title: selected.title,
      rationale: selected.reason,
      estimatedMinutes: selected.estimatedMinutes,
      conceptKeys: JSON.stringify(selected.conceptKeys),
      sourceDocumentIds: JSON.stringify(selected.sourceDocumentIds),
      payload: selected.payload ? JSON.stringify(selected.payload) : null,
      planStateVersion: state.plan.stateVersion,
    },
  });
  await prisma.coachRun.create({
    data: {
      studyPlanId,
      trigger,
      candidateActions: JSON.stringify(candidates),
      selectedActionType: selected.type,
      selectedActionId: action.id,
      provider,
      model,
      durationMs: Date.now() - started,
      status,
      policyRejected,
      errorCode,
    },
  });
  return toCoachActionDTO(action);
}
