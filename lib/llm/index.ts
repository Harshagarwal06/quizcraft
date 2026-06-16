import { GeneratedQuiz, GenerationInput, QuizGenerator } from "./types";
import { HuggingFaceGenerator } from "./huggingface";
import { GeminiGenerator } from "./gemini";

export type Provider = "hf" | "gemini";

function normalizeProvider(p?: string): Provider {
  if (p === "gemini" || p === "google") return "gemini";
  if (p === "hf" || p === "huggingface") return "hf";
  if (p) throw new Error(`Unknown LLM_PROVIDER: "${p}". Valid values: hf, gemini`);
  return "hf";
}

export function getGenerator(): QuizGenerator {
  return generatorFor(normalizeProvider(process.env.LLM_PROVIDER));
}

// Construct a generator; throws if that provider's API key is missing.
function generatorFor(p: Provider): QuizGenerator {
  return p === "gemini" ? new GeminiGenerator() : new HuggingFaceGenerator();
}

// Each generation needs roughly this much wall-clock; don't start a fallback
// attempt unless at least this much of the request budget remains.
const MIN_ATTEMPT_MS = 26_000;

/**
 * Generate with automatic provider fallback. Tries the preferred provider first,
 * then the other one (if its key is configured) — but only if enough of the
 * request budget remains, so a fallback can never push past the 60s function
 * limit. Returns which provider actually produced the quiz.
 */
export async function generateWithFallback(
  input: GenerationInput,
  preferred: string,
  deadline: number
): Promise<{ quiz: GeneratedQuiz; provider: Provider }> {
  const first = normalizeProvider(preferred);
  const order: Provider[] = first === "gemini" ? ["gemini", "hf"] : ["hf", "gemini"];

  let lastError: unknown;
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    if (i > 0 && Date.now() + MIN_ATTEMPT_MS > deadline) break; // no budget to fall back
    let generator: QuizGenerator;
    try {
      generator = generatorFor(p); // may throw if key missing
    } catch {
      continue; // provider not configured — skip
    }
    try {
      const quiz = await generator.generate(input);
      return { quiz, provider: p };
    } catch (err) {
      lastError = err;
      const more = i < order.length - 1;
      console.warn(
        `[quizzes] provider ${p} failed${more ? ", attempting fallback" : ""}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(lastError ? String(lastError) : "No LLM provider configured");
}

export type { QuizGenerator, GeneratedQuiz, GenerationInput } from "./types";
