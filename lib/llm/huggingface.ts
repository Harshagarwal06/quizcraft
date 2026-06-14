import { generatedQuizSchema, GeneratedQuiz, GenerationInput, QuizGenerator } from "./types";

const HF_MODEL = "Qwen/Qwen2.5-72B-Instruct";
// HuggingFace Inference Providers router (OpenAI-compatible)
const HF_ENDPOINT = "https://router.huggingface.co/v1/chat/completions";

const SYSTEM_PROMPT = `You are an expert educator and quiz designer. Your task is to generate high-quality multiple-choice questions (MCQs) from provided study material.

REQUIREMENTS:
1. DIFFICULTY MIX: Aim for ~30% easy, ~40% medium, ~30% hard questions. Label each question clearly.
2. COVERAGE: First identify the key topics in the material, then distribute questions across all of them. Include a "topic" field per question.
3. ANSWER OPTIONS: Always provide exactly 4 options (A, B, C, D). Randomize which letter holds the correct answer. Options must be plausible distractors — not obviously wrong.
4. EXPLANATIONS: Every question must include a concise explanation covering (a) why the correct answer is right, (b) why each distractor is wrong. Keep it under 80 words.
5. QUESTION STEMS: Clear, unambiguous, testing understanding not just recall. No "all of the above" or "none of the above."
6. FRESHNESS: Use the provided seed value to vary phrasing and question angles so repeated generations differ.
7. FORMAT: Plain text only — no markdown, LaTeX, or special characters. Stems ≤120 chars, option text ≤80 chars each.
8. TITLE: Generate a descriptive title for the quiz based on the content.

You MUST respond with valid JSON only — no prose, no markdown fences. The JSON must match this exact shape:
{
  "title": "string",
  "questions": [
    {
      "stem": "string",
      "options": [
        { "id": "A", "text": "string" },
        { "id": "B", "text": "string" },
        { "id": "C", "text": "string" },
        { "id": "D", "text": "string" }
      ],
      "correctOptionId": "A" | "B" | "C" | "D",
      "explanation": "string",
      "difficulty": "easy" | "medium" | "hard",
      "topic": "string"
    }
  ]
}`;

function buildUserMessage(input: GenerationInput): string {
  const lines: string[] = [];
  if (input.userPrompt) lines.push(`FOCUS: ${input.userPrompt}\n`);
  lines.push(`SEED: ${input.seed} (use this to vary your output)\n`);
  lines.push(`Generate exactly ${input.questionCount} MCQs from the following material:\n`);
  lines.push("---");
  lines.push(input.sourceText.slice(0, 60000));
  return lines.join("\n");
}

/**
 * Robustly extract a JSON object from model output that may be wrapped in
 * markdown fences or surrounded by prose.
 */
function extractJson(content: string): unknown {
  const trimmed = content.trim();

  // Try direct parse first
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // Grab the outermost {...} block
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      // fall through
    }
  }

  throw new Error(`Failed to parse JSON from model output: ${trimmed.slice(0, 200)}`);
}

export class HuggingFaceGenerator implements QuizGenerator {
  private apiKey: string;

  constructor() {
    const key = process.env.HF_API_KEY;
    if (!key) throw new Error("HF_API_KEY environment variable is not set");
    this.apiKey = key;
  }

  async generate(input: GenerationInput): Promise<GeneratedQuiz> {
    const response = await fetch(HF_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: HF_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(input) },
        ],
        max_tokens: 8000,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => response.statusText);
      throw new Error(`HuggingFace API error ${response.status}: ${err}`);
    }

    const data = await response.json() as {
      choices: { message: { content: string } }[];
      error?: string;
    };

    if (data.error) throw new Error(`HuggingFace API error: ${data.error}`);

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty response from HuggingFace API");

    const raw = extractJson(content);

    const parsed = generatedQuizSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Model output failed schema validation: ${parsed.error.message}`);
    }

    parsed.data.questions = parsed.data.questions.slice(0, input.questionCount);
    return parsed.data;
  }
}
