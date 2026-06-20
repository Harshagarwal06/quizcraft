export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { refreshCoachRecommendation } from "@/lib/coach/planner";
import { buildCoachSnapshot } from "@/lib/coach/state";
import { isCoachEnabled } from "@/lib/coach/types";

export async function POST() {
  if (!isCoachEnabled()) {
    return NextResponse.json({ error: "Study coach is disabled." }, { status: 503 });
  }
  const userId = await getCurrentUserId();
  const plan = await prisma.studyPlan.findFirst({
    where: { userId, status: "active", activeKey: userId },
    select: { id: true },
  });
  if (!plan) {
    return NextResponse.json({ error: "No active study plan." }, { status: 409 });
  }
  await refreshCoachRecommendation(userId, plan.id, "manual_refresh");
  return NextResponse.json(await buildCoachSnapshot(userId));
}
