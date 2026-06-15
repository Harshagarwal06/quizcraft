import { generatedQuizSchema, GeneratedQuiz, GenerationInput, QuizGenerator } from "./types";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
// Cap a single generation so the route's maxDuration (60s) isn't exceeded even
// when topic expansion (also Gemini, up to ~12s) ran first.
const TIMEOUT_MS = 30_000;

// Gemini structured-output schema (OpenAPI subset) mirroring generatedQuizSchema.
const RESPONSE_SCHEMA = {
  type: "object",
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
            },
          },
          correctOptionId: { type: "string", enum: ["A", "B", "C", "D"] },
          explanation: { type: "string" },
          difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
          topic: { type: "string" },
        },
        required: ["stem", "options", "correctOptionId", "explanation", "difficulty", "topic"],
      },
    },
  },
  required: ["title", "questions"],
};

/**
 * Generates a quiz with Google Gemini using structured JSON output. Lets the
 * whole app run on a single GEMINI_API_KEY (same key as the expansion stage).
 */
export class GeminiGenerator implements QuizGenerator {
  private apiKey: string;
  private model: string;

  constructor() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY environment variable is not set");
    this.apiKey = key;
    this.model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  }

  private async callModel(input: GenerationInput): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const url = `${ENDPOINT}/${this.model}:generateContent?key=${this.apiKey}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: buildUserMessage(input) }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 4096,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            // No reasoning tokens needed for structured generation; keeps it fast.
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      });

      if (!response.ok) {
        const err = await response.text().catch(() => response.statusText);
        throw new Error(`Gemini API error ${response.status}: ${err}`);
      }

      const data = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = data.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? "")
        .join("");
      if (!text) throw new Error("Empty response from Gemini API");
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  async generate(input: GenerationInput): Promise<GeneratedQuiz> {
    const MAX_ATTEMPTS = 2;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Vary the seed each retry so a malformed generation isn't repeated.
        const content = await this.callModel({ ...input, seed: input.seed + attempt - 1 });
        const raw = JSON.parse(content);
        const parsed = generatedQuizSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(`Schema validation failed: ${parsed.error.message}`);
        }
        parsed.data.questions = parsed.data.questions.slice(0, input.questionCount);
        return parsed.data;
      } catch (err) {
        lastError = err;
        const timedOut = err instanceof Error && err.name === "AbortError";
        console.warn(
          `[gemini] generation attempt ${attempt} failed${timedOut ? " (timeout)" : ""}:`,
          err
        );
        // A timeout means we're near the route's time budget — retrying would
        // risk a hard Vercel 60s kill, so stop and fail fast instead.
        if (timedOut) break;
      }
    }

    throw new Error(
      `Quiz generation failed after ${MAX_ATTEMPTS} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  }
}
