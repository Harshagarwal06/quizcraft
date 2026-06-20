export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserId } from "@/lib/currentUser";
import { updateStudyPlan } from "@/lib/coach/plan";
import { refreshCoachRecommendation } from "@/lib/coach/planner";
import { buildCoachSnapshot } from "@/lib/coach/state";
import { isCoachEnabled } from "@/lib/coach/types";

const schema = z.object({
  confirmed: z.boolean().optional().default(false),
  changes: z
    .object({
      examTitle: z.string().trim().min(3).max(120).optional(),
      examDate: z.string().datetime().optional(),
      targetScore: z.number().int().min(1).max(100).optional(),
      dailyMinutes: z.number().int().min(10).max(240).optional(),
      availableDays: z
        .array(z.number().int().min(0).max(6))
        .min(1)
        .max(7)
        .optional(),
    })
    .refine((changes) => Object.keys(changes).length > 0),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isCoachEnabled()) {
    return NextResponse.json({ error: "Study coach is disabled." }, { status: 503 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid plan update." }, { status: 400 });
  }
  if (!parsed.data.confirmed) {
    return NextResponse.json(
      {
        error: "Plan changes require confirmation.",
        requiresConfirmation: true,
        changes: parsed.data.changes,
      },
      { status: 409 }
    );
  }
  const { id } = await params;
  const userId = await getCurrentUserId();
  const changes = {
    ...parsed.data.changes,
    examDate: parsed.data.changes.examDate
      ? new Date(parsed.data.changes.examDate)
      : undefined,
  };
  try {
    await updateStudyPlan(userId, id, changes);
    await refreshCoachRecommendation(userId, id, "plan_updated");
    return NextResponse.json(await buildCoachSnapshot(userId));
  } catch (error) {
    if (error instanceof Error && error.message === "PLAN_NOT_FOUND") {
      return NextResponse.json({ error: "Study plan not found." }, { status: 404 });
    }
    return NextResponse.json(
      { error: "Couldn't update the study plan." },
      { status: 500 }
    );
  }
}
