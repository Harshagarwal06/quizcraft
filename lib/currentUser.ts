import { prisma, ensureSchema } from "./db";

const GUEST_EMAIL = "guest@quizcraft.local";

/**
 * Returns the current user's id. Auth is currently disabled, so every request
 * maps to a single shared "guest" account — this keeps behaviour consistent
 * even for browsers that still hold a stale session cookie from before sign-in
 * was removed. To re-enable real auth, check `(await auth()).user.id` first and
 * fall back to the guest user only when there's no session.
 */
export async function getCurrentUserId(): Promise<string> {
  await ensureSchema();

  const guest = await prisma.user.upsert({
    where: { email: GUEST_EMAIL },
    update: {},
    create: { email: GUEST_EMAIL, name: "Guest" },
  });
  return guest.id;
}
