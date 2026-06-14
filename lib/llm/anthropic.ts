import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { generatedQuizSchema, GeneratedQuiz, GenerationInput, QuizGenerator } from "./types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an expert educator and quiz designer. Your task is to generate high-quality multiple-choice questions (MCQs) from provided study material.

REQUIREMENTS:
1. DIFFICULTY MIX: Aim for ~30% easy, ~40% medium, ~30% hard questions. Label each question clearly.
2. COVERAGE: First identify the key topics in the material, then distribute questions across all of them. Include a "topic" field per question.
3. ANSWER OPTIONS: Always provide exactly 4 options (A, B, C, D). Randomize which letter holds the correct answer. Options must be plausible distractors — not obviously wrong.
4. EXPLANATIONS: Every question must include a concise explanation covering (a) why the correct answer is right, (b) why each distractor is wrong. Keep it under 80 words.
5. QUESTION STEMS: Clear, unambiguous, testing understanding not just recall. No "all of the above" or "none of the above."
6. FRESHNESS: Use the provided seed value to vary phrasing and question angles so repeated generations differ.
7. FORMAT: Plain text only — no markdown, LaTeX, or special characters. Stems ≤120 chars, option text ≤80 chars each.
8. TITLE: Generate a descriptive title for the quiz based on the content.`;

function buildUserPrompt(input: GenerationInput): string {
  const lines: string[] = [];
  if (input.userPrompt) lines.push(`FOCUS: ${input.userPrompt}\n`);
  lines.push(`SEED: ${input.seed} (use this to vary your output)\n`);
  lines.push(`Generate exactly ${input.questionCount} MCQs from the following material:\n`);
  lines.push("---");
  lines.push(input.sourceText.slice(0, 60000)); // cap to avoid token overflow
  return lines.join("\n");
}

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
      messages: [{ role: "user", content: buildUserPrompt(input) }],
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
