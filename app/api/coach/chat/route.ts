export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserId } from "@/lib/currentUser";
import { handleCoachChat } from "@/lib/coach/chat";
import { isCoachEnabled } from "@/lib/coach/types";

const schema = z.object({
  message: z.string().trim().min(2).max(1000),
});

export async function POST(req: NextRequest) {
  if (!isCoachEnabled()) {
    return NextResponse.json({ error: "Study coach is disabled." }, { status: 503 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid message." }, { status: 400 });
  }
  const userId = await getCurrentUserId();
  try {
    return NextResponse.json(
      await handleCoachChat(userId, parsed.data.message)
    );
  } catch (error) {
    if (error instanceof Error && error.message === "NO_ACTIVE_PLAN") {
      return NextResponse.json({ error: "Create a study plan first." }, { status: 409 });
    }
    return NextResponse.json(
      { error: "The study coach couldn't respond." },
      { status: 500 }
    );
  }
}
