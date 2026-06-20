import {
  callGeminiJSON,
  callHFChat,
  extractJsonLoose,
  geminiModelName,
  HF_MODEL_NAME,
} from "./client";

export type StructuredProvider = "gemini" | "hf";

function preferredOrder(
  preferredProvider?: StructuredProvider
): StructuredProvider[] {
  if (preferredProvider) {
    return preferredProvider === "gemini"
      ? ["gemini", "hf"]
      : ["hf", "gemini"];
  }
  const structuredPreference = process.env.STRUCTURED_LLM_PROVIDER;
  if (
    structuredPreference === "gemini" ||
    structuredPreference === "google"
  ) {
    return ["gemini", "hf"];
  }
  if (
    structuredPreference === "hf" ||
    structuredPreference === "huggingface"
  ) {
    return ["hf", "gemini"];
  }
  // Gemini enforces the response schema at the API boundary. Prefer it for
  // evidence blueprints/questions when available instead of spending most of a
  // serverless request waiting for an HF timeout before falling back.
  if (process.env.GEMINI_API_KEY) return ["gemini", "hf"];
  const preferred =
    process.env.LLM_PROVIDER === "gemini" ||
    process.env.LLM_PROVIDER === "google"
      ? "gemini"
      : "hf";
  return preferred === "gemini" ? ["gemini", "hf"] : ["hf", "gemini"];
}

function configured(provider: StructuredProvider): boolean {
  return provider === "gemini"
    ? Boolean(process.env.GEMINI_API_KEY)
    : Boolean(process.env.HF_API_KEY);
}

export async function callStructuredWithFallback(opts: {
  system: string;
  user: string;
  schema: unknown;
  maxTokens: number;
  timeoutMs: number;
  preferredProvider?: StructuredProvider;
}): Promise<{ raw: unknown; provider: StructuredProvider; model: string }> {
  let lastError: unknown;
  for (const provider of preferredOrder(opts.preferredProvider)) {
    if (!configured(provider)) continue;
    try {
      if (provider === "gemini") {
        const text = await callGeminiJSON({
          system: opts.system,
          user: opts.user,
          schema: opts.schema,
          maxTokens: opts.maxTokens,
          timeoutMs: opts.timeoutMs,
        });
        return {
          raw: JSON.parse(text),
          provider,
          model: geminiModelName(),
        };
      }
      const text = await callHFChat({
        system: opts.system,
        user: opts.user,
        maxTokens: opts.maxTokens,
        timeoutMs: opts.timeoutMs,
        temperature: 0.2,
      });
      return {
        raw: extractJsonLoose(text),
        provider,
        model: HF_MODEL_NAME,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No configured structured-output provider is available.");
}
