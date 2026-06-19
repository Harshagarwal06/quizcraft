import {
  callGeminiJSON,
  callHFChat,
  extractJsonLoose,
  geminiModelName,
  HF_MODEL_NAME,
} from "./client";

export type StructuredProvider = "gemini" | "hf";

function preferredOrder(): StructuredProvider[] {
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
}): Promise<{ raw: unknown; provider: StructuredProvider; model: string }> {
  let lastError: unknown;
  for (const provider of preferredOrder()) {
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
