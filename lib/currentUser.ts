import { auth } from "./auth";
import { prisma, ensureSchema } from "./db";

const GUEST_EMAIL = "guest@quizcraft.local";

/**
 * Returns the current user's id. While auth is disabled, falls back to a
 * single shared "guest" account so the app works without signing in.
 * Re-enable real auth by reverting to `(await auth()).user.id` checks.
 */
export async function getCurrentUserId(): Promise<string> {
  await ensureSchema();

  const session = await auth();
  if (session?.user?.id) return session.user.id;

  const guest = await prisma.user.upsert({
    where: { email: GUEST_EMAIL },
    update: {},
    create: { email: GUEST_EMAIL, name: "Guest" },
  });
  return guest.id;
}
