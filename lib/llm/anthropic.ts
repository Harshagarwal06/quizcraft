import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { generatedQuizSchema, GeneratedQuiz, GenerationInput, QuizGenerator } from "./types";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    title: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          stem: { type: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", enum: ["A", "B", "C", "D"] },
                text: { type: "string" },
              },
              required: ["id", "text"],
              additionalProperties: false,
            },
            minItems: 4,
            maxItems: 4,
          },
          correctOptionId: { type: "string", enum: ["A", "B", "C", "D"] },
          explanation: { type: "string" },
          difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
          topic: { type: "string" },
        },
        required: ["stem", "options", "correctOptionId", "explanation", "difficulty", "topic"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "questions"],
  additionalProperties: false,
};

export class AnthropicGenerator implements QuizGenerator {
  async generate(input: GenerationInput): Promise<GeneratedQuiz> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 8000,
      thinking: { type: "adaptive" } as unknown as undefined,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessage(input) }],
      stream: false,
      // output_config is a newer SDK feature; cast to bypass strict typing
      ...({
        output_config: {
          format: {
            type: "json_schema",
            name: "quiz",
            schema: OUTPUT_SCHEMA,
            strict: true,
          },
        },
      } as object),
    })) as Message;

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text content in LLM response");
    }

    const raw = JSON.parse(textBlock.text);
    const parsed = generatedQuizSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`LLM output failed validation: ${parsed.error.message}`);
    }

    // Enforce requested question count (trim if LLM returned more)
    parsed.data.questions = parsed.data.questions.slice(0, input.questionCount);
    return parsed.data;
  }
}
