export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { refreshCoachRecommendation } from "@/lib/coach/planner";
import { buildCoachSnapshot } from "@/lib/coach/state";
import { isCoachEnabled } from "@/lib/coach/types";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isCoachEnabled()) {
    return NextResponse.json({ error: "Study coach is disabled." }, { status: 503 });
  }
  const userId = await getCurrentUserId();
  const { id } = await params;
  const action = await prisma.coachAction.findFirst({
    where: {
      id,
      studyPlan: { userId },
      status: { in: ["proposed", "failed"] },
    },
    select: { id: true, studyPlanId: true },
  });
  if (!action) {
    return NextResponse.json({ error: "Coach action not found." }, { status: 404 });
  }
  await prisma.coachAction.update({
    where: { id: action.id },
    data: { status: "dismissed" },
  });
  await refreshCoachRecommendation(
    userId,
    action.studyPlanId,
    "action_dismissed"
  );
  return NextResponse.json(await buildCoachSnapshot(userId));
}
