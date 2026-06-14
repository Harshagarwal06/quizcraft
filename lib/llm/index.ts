import { QuizGenerator } from "./types";
import { AnthropicGenerator } from "./anthropic";
import { HuggingFaceGenerator } from "./huggingface";

export function getGenerator(): QuizGenerator {
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  switch (provider) {
    case "anthropic":
      return new AnthropicGenerator();
    case "hf":
    case "huggingface":
      return new HuggingFaceGenerator();
    default:
      throw new Error(`Unknown LLM_PROVIDER: "${provider}". Valid values: anthropic, hf`);
  }
}

export type { QuizGenerator, GeneratedQuiz, GenerationInput } from "./types";
