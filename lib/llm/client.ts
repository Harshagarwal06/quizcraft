// Low-level provider callers that return raw model text. These mirror the
// transport patterns in huggingface.ts / gemini.ts (AbortController timeout,
// error shape) so callers like the verifier don't duplicate them.

const HF_ENDPOINT = "https://router.huggingface.co/v1/chat/completions";
const HF_MODEL = "Qwen/Qwen2.5-72B-Instruct";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export function geminiModelName(): string {
  return process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
}

export const HF_MODEL_NAME = HF_MODEL;

// Matches ASCII control chars (0x00–0x1F) without a literal control char in
// source — these are invalid raw inside JSON strings.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F]", "g");

/** OpenAI-compatible chat call against the HF Inference Providers router. */
export async function callHFChat(opts: {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  temperature?: number;
}): Promise<string> {
  const key = process.env.HF_API_KEY;
  if (!key) throw new Error("HF_API_KEY environment variable is not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let response: Response;
  try {
    response = await fetch(HF_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: HF_MODEL,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        max_tokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.2,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`HuggingFace request timed out after ${opts.timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const err = await response.text().catch(() => response.statusText);
    throw new Error(`HuggingFace API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: string;
  };
  if (data.error) throw new Error(`HuggingFace API error: ${data.error}`);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from HuggingFace API");
  return content;
}

/** Gemini structured-JSON call (responseSchema, thinking disabled). */
export async function callGeminiJSON(opts: {
  system: string;
  user: string;
  schema: unknown;
  maxTokens: number;
  timeoutMs: number;
  model?: string;
}): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY environment variable is not set");
  const model = opts.model ?? geminiModelName();

  const url = `${GEMINI_ENDPOINT}/${model}:generateContent?key=${key}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: [{ role: "user", parts: [{ text: opts.user }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: opts.maxTokens,
      responseMimeType: "application/json",
      responseSchema: opts.schema,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  // Rate-limit backoff is opt-in (EVAL_GEMINI_BACKOFF=1, set by the eval harness)
  // so the app's time-budgeted routes are unaffected; free-tier Gemini is ~5 RPM.
  const maxRetries = process.env.EVAL_GEMINI_BACKOFF === "1" ? 8 : 0;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body,
      });

      if (!response.ok) {
        const err = await response.text().catch(() => response.statusText);
        if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
          clearTimeout(timer);
          const m = err.match(/"retryDelay":\s*"(\d+)s"/);
          const waitMs = Math.min(30_000, (m ? Number(m[1]) : 15) * 1000 + 1000);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw new Error(`Gemini API error ${response.status}: ${err}`);
      }

      const data = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
      if (!text) throw new Error("Empty response from Gemini API");
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Generic, tolerant JSON extraction for providers that don't guarantee clean
 * JSON (HF). Tries direct parse, then a control-char-stripped parse, then a
 * fenced block, then the outermost {...}.
 */
export function extractJsonLoose(content: string): unknown {
  const tryParse = (s: string): unknown | undefined => {
    try {
      return JSON.parse(s);
    } catch {
      try {
        return JSON.parse(s.replace(CONTROL_CHARS, " "));
      } catch {
        return undefined;
      }
    }
  };

  const trimmed = content.trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const parsed = tryParse(fence[1].trim());
    if (parsed !== undefined) return parsed;
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const parsed = tryParse(trimmed.slice(first, last + 1));
    if (parsed !== undefined) return parsed;
  }

  throw new Error(`Failed to parse JSON from model output: ${trimmed.slice(0, 200)}`);
}
