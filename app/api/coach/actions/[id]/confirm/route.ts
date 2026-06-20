export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/currentUser";
import { confirmCoachAction } from "@/lib/coach/executor";
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
  try {
    const result = await confirmCoachAction(userId, id);
    return NextResponse.json({ action: result.action }, { status: result.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "ACTION_NOT_FOUND") {
      return NextResponse.json({ error: "Coach action not found." }, { status: 404 });
    }
    if (message === "STALE_ACTION") {
      return NextResponse.json(
        { error: "This recommendation is stale. Refresh your coach." },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "This action cannot be confirmed." },
      { status: 409 }
    );
  }
}
