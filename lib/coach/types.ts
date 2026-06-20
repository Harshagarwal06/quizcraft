import { z } from "zod";

export const coachActionTypeSchema = z.enum([
  "lesson",
  "quiz",
  "review",
  "request_source",
  "rest",
]);

export const coachActionStatusSchema = z.enum([
  "proposed",
  "approved",
  "preparing",
  "ready",
  "started",
  "completed",
  "dismissed",
  "failed",
]);

export type CoachActionType = z.infer<typeof coachActionTypeSchema>;
export type CoachActionStatus = z.infer<typeof coachActionStatusSchema>;

export const COACH_TOOL_ALLOWLIST = [
  "retrieve_plan_state",
  "retrieve_source_chunks",
  "answer_grounded_question",
  "generate_cited_lesson",
  "generate_standard_quiz",
  "generate_targeted_review",
  "propose_plan_update",
  "request_additional_material",
] as const;

export type CoachToolName = (typeof COACH_TOOL_ALLOWLIST)[number];

export type CoachEvidence = {
  quote: string;
  sourceTitle: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  url: string | null;
};

export type CoachCandidate = {
  id: string;
  type: CoachActionType;
  tool: CoachToolName | null;
  title: string;
  reason: string;
  estimatedMinutes: number;
  conceptKeys: string[];
  sourceDocumentIds: string[];
  score: number;
  payload?: Record<string, unknown>;
};

export type CoachActionDTO = {
  id: string;
  type: CoachActionType;
  status: CoachActionStatus;
  title: string;
  reason: string;
  estimatedMinutes: number;
  requiresConfirmation: boolean;
  conceptKeys: string[];
  readyHref: string | null;
  error: string | null;
};

export function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function isCoachEnabled(): boolean {
  return process.env.COACH_AGENT_ENABLED !== "false";
}

export function isAllowedCoachTool(value: string): value is CoachToolName {
  return (COACH_TOOL_ALLOWLIST as readonly string[]).includes(value);
}

export function toCoachActionDTO(action: {
  id: string;
  type: string;
  status: string;
  title: string;
  rationale: string;
  estimatedMinutes: number;
  conceptKeys: string;
  readyHref: string | null;
  errorMessage: string | null;
}): CoachActionDTO {
  return {
    id: action.id,
    type: coachActionTypeSchema.parse(action.type),
    status: coachActionStatusSchema.parse(action.status),
    title: action.title,
    reason: action.rationale,
    estimatedMinutes: action.estimatedMinutes,
    requiresConfirmation:
      action.status === "proposed" || action.status === "failed",
    conceptKeys: parseStringArray(action.conceptKeys),
    readyHref: action.readyHref,
    error: action.errorMessage,
  };
}
