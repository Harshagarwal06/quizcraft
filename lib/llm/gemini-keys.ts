const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 30 * 60_000;

let preferredKeyIndex = 0;
const cooldownUntil = new Map<string, number>();

function splitKeys(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\n,]/)
    .map((key) => key.trim())
    .filter(Boolean);
}

export function getGeminiApiKeys(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return [
    ...splitKeys(env.GEMINI_API_KEYS),
    env.GEMINI_API_KEY_1,
    env.GEMINI_API_KEY_2,
    env.GEMINI_API_KEY_3,
    env.GEMINI_API_KEY,
  ]
    .map((key) => key?.trim() ?? "")
    .filter((key, index, keys) => Boolean(key) && keys.indexOf(key) === index)
    .slice(0, 3);
}

export function hasGeminiApiKeys(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return getGeminiApiKeys(env).length > 0;
}

export class GeminiRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "GeminiRequestError";
  }
}

function retryAfterMs(detail: string): number | undefined {
  const seconds =
    detail.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)?.[1] ??
    detail.match(/retry(?:\s+after|\s+in)?\s+(\d+(?:\.\d+)?)\s*s/i)?.[1];
  if (!seconds) return undefined;
  return Math.min(MAX_COOLDOWN_MS, Math.ceil(Number(seconds) * 1000));
}

function shouldFailOver(error: unknown): boolean {
  if (error instanceof GeminiRequestError) {
    return (
      error.status === undefined ||
      error.status === 401 ||
      error.status === 403 ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  return (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function keyId(key: string): string {
  return `${key.slice(0, 4)}:${key.slice(-4)}`;
}

function orderedKeys(keys: string[]): { key: string; index: number }[] {
  const now = Date.now();
  const ordered = Array.from({ length: keys.length }, (_, offset) => {
    const index = (preferredKeyIndex + offset) % keys.length;
    return { key: keys[index], index };
  });
  const available = ordered.filter(
    ({ key }) => (cooldownUntil.get(keyId(key)) ?? 0) <= now
  );
  return available.length > 0 ? available : ordered;
}

async function runWithGeminiKeyFallback<T>(
  keys: string[],
  operation: (key: string, attemptsLeft: number) => Promise<T>
): Promise<T> {
  let lastError: unknown;
  const candidates = orderedKeys(keys);
  for (const [attempt, { key, index }] of candidates.entries()) {
    try {
      const result = await operation(key, candidates.length - attempt);
      preferredKeyIndex = index;
      cooldownUntil.delete(keyId(key));
      return result;
    } catch (error) {
      lastError = error;
      if (!shouldFailOver(error)) throw error;
      const waitMs =
        error instanceof GeminiRequestError
          ? error.retryAfterMs ?? DEFAULT_COOLDOWN_MS
          : DEFAULT_COOLDOWN_MS;
      cooldownUntil.set(keyId(key), Date.now() + waitMs);
      preferredKeyIndex = (index + 1) % keys.length;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("All configured Gemini API keys failed.");
}

export async function fetchGeminiWithFallback(opts: {
  endpoint: string;
  init: Omit<RequestInit, "signal">;
  timeoutMs: number;
  label: string;
  fetchImpl?: typeof fetch;
  keys?: string[];
}): Promise<Response> {
  const keys = opts.keys ?? getGeminiApiKeys();
  if (keys.length === 0) {
    throw new Error(
      "No Gemini API key is configured. Set GEMINI_API_KEYS, GEMINI_API_KEY_1..3, or GEMINI_API_KEY."
    );
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + opts.timeoutMs;

  return runWithGeminiKeyFallback(keys, async (key, attemptsLeft) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new GeminiRequestError(
        `${opts.label} timed out after ${opts.timeoutMs / 1000}s.`
      );
    }
    // Keep the whole key pool inside the caller's original time budget. A fast
    // 401/429 leaves almost all of the budget for the next key; a hung key gets
    // most, but not all, of the remaining time.
    const attemptTimeoutMs =
      attemptsLeft === 1
        ? remainingMs
        : Math.max(1000, Math.floor(remainingMs * 0.7));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      let response: Response;
      try {
        const separator = opts.endpoint.includes("?") ? "&" : "?";
        response = await fetchImpl(
          `${opts.endpoint}${separator}key=${encodeURIComponent(key)}`,
          {
            ...opts.init,
            signal: controller.signal,
          }
        );
      } catch (error) {
        if (controller.signal.aborted) {
          throw new GeminiRequestError(
            `${opts.label} timed out while trying a configured key.`
          );
        }
        throw error;
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => response.statusText);
        let providerMessage = response.statusText;
        try {
          const parsed = JSON.parse(detail) as { error?: { message?: string } };
          providerMessage =
            parsed.error?.message?.split("\n")[0]?.trim() || providerMessage;
        } catch {
          providerMessage = detail.slice(0, 300) || providerMessage;
        }
        throw new GeminiRequestError(
          `${opts.label} failed (${response.status}): ${providerMessage}`,
          response.status,
          retryAfterMs(detail)
        );
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  });
}

export function resetGeminiKeyPoolForTests(): void {
  preferredKeyIndex = 0;
  cooldownUntil.clear();
}
