export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserId } from "@/lib/currentUser";
import { createStudyPlan } from "@/lib/coach/plan";
import { refreshCoachRecommendation } from "@/lib/coach/planner";
import { buildCoachSnapshot } from "@/lib/coach/state";
import { isCoachEnabled } from "@/lib/coach/types";

const schema = z.object({
  examTitle: z.string().trim().min(3).max(120),
  examDate: z.string().datetime(),
  targetScore: z.number().int().min(1).max(100),
  dailyMinutes: z.number().int().min(10).max(240),
  availableDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  sourceDocumentIds: z.array(z.string().min(1)).min(1).max(20),
});

export async function POST(req: NextRequest) {
  if (!isCoachEnabled()) {
    return NextResponse.json({ error: "Study coach is disabled." }, { status: 503 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid study plan." }, { status: 400 });
  }
  const examDate = new Date(parsed.data.examDate);
  if (examDate.getTime() < Date.now() - 86_400_000) {
    return NextResponse.json(
      { error: "Exam date must be today or later." },
      { status: 400 }
    );
  }
  const userId = await getCurrentUserId();
  try {
    const plan = await createStudyPlan(userId, {
      ...parsed.data,
      examDate,
    });
    await refreshCoachRecommendation(userId, plan.id, "plan_created");
    return NextResponse.json(await buildCoachSnapshot(userId), { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null;
    if (message === "ACTIVE_PLAN_EXISTS" || code === "P2002") {
      return NextResponse.json(
        { error: "An active study plan already exists." },
        { status: 409 }
      );
    }
    if (message === "SOURCE_NOT_FOUND") {
      return NextResponse.json(
        { error: "One or more selected sources are unavailable." },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Couldn't create the study plan." },
      { status: 500 }
    );
  }
}
