export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/currentUser";
import { buildCoachSnapshot } from "@/lib/coach/state";
import { isCoachEnabled } from "@/lib/coach/types";

export async function GET() {
  if (!isCoachEnabled()) {
    return NextResponse.json({
      enabled: false,
      plan: null,
      availableSources: [],
      recommendation: null,
      messages: [],
    });
  }
  const userId = await getCurrentUserId();
  return NextResponse.json(await buildCoachSnapshot(userId));
}
