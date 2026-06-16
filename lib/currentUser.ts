import { prisma, ensureSchema } from "./db";

const GUEST_EMAIL = "guest@quizcraft.local";

// The guest user is created once and its id never changes, so cache it per
// process to skip a DB round-trip (the upsert below) on every request.
const globalForGuest = globalThis as unknown as { guestUserId?: string };

/**
 * Returns the current user's id. Auth is currently disabled, so every request
 * maps to a single shared "guest" account — this keeps behaviour consistent
 * even for browsers that still hold a stale session cookie from before sign-in
 * was removed. To re-enable real auth, check `(await auth()).user.id` first and
 * fall back to the guest user only when there's no session.
 */
export async function getCurrentUserId(): Promise<string> {
  if (globalForGuest.guestUserId) return globalForGuest.guestUserId;

  await ensureSchema();

  const guest = await prisma.user.upsert({
    where: { email: GUEST_EMAIL },
    update: {},
    create: { email: GUEST_EMAIL, name: "Guest" },
  });
  globalForGuest.guestUserId = guest.id;
  return guest.id;
}
