import { QuizGenerator } from "./types";
import { AnthropicGenerator } from "./anthropic";
import { HuggingFaceGenerator } from "./huggingface";
import { GeminiGenerator } from "./gemini";

export function getGenerator(): QuizGenerator {
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  switch (provider) {
    case "anthropic":
      return new AnthropicGenerator();
    case "hf":
    case "huggingface":
      return new HuggingFaceGenerator();
    case "gemini":
    case "google":
      return new GeminiGenerator();
    default:
      throw new Error(`Unknown LLM_PROVIDER: "${provider}". Valid values: anthropic, hf, gemini`);
  }
}

export type { QuizGenerator, GeneratedQuiz, GenerationInput } from "./types";
