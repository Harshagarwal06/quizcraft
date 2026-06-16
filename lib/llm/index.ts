import { QuizGenerator } from "./types";
import { HuggingFaceGenerator } from "./huggingface";
import { GeminiGenerator } from "./gemini";

export function getGenerator(): QuizGenerator {
  const provider = process.env.LLM_PROVIDER ?? "hf";
  switch (provider) {
    case "hf":
    case "huggingface":
      return new HuggingFaceGenerator();
    case "gemini":
    case "google":
      return new GeminiGenerator();
    default:
      throw new Error(`Unknown LLM_PROVIDER: "${provider}". Valid values: hf, gemini`);
  }
}

export type { QuizGenerator, GeneratedQuiz, GenerationInput } from "./types";
