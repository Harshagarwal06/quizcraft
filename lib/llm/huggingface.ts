import { generatedQuizSchema, GeneratedQuiz, GenerationInput, QuizGenerator } from "./types";
import { buildUserMessage, generationSystemPrompt } from "./prompt";
import { validateReviewQuiz } from "./review";

const HF_MODEL = "Qwen/Qwen2.5-72B-Instruct";
// HuggingFace Inference Providers router (OpenAI-compatible)
const HF_ENDPOINT = "https://router.huggingface.co/v1/chat/completions";

// A single question's JSON (stem, 4 options, explanation, metadata) runs
// ~280 tokens; budget generously per question plus title/structure overhead.
// Output tokens dominate latency on a 72B model, so capping this to what we
// actually need — instead of the old fixed 8192 — is the main guard against
// the 60s serverless timeout.
const TOKENS_PER_QUESTION = 320;
const TOKEN_OVERHEAD = 400;
const MAX_OUTPUT_TOKENS = 8192; // provider hard cap for this model

function maxTokensFor(questionCount: number): number {
  return Math.min(MAX_OUTPUT_TOKENS, TOKEN_OVERHEAD + questionCount * TOKENS_PER_QUESTION);
}

// Abort a single model call before the serverless function's hard timeout so
// we fail with a clean error (and can surface it) instead of being killed.
// The route may spend up to ~12s on Gemini topic expansion before calling us,
// so this leaves headroom under the route's 60s maxDuration (12 + 40 + parse
// + DB write < 60s).
const CALL_TIMEOUT_MS = 40_000;
// Total wall-clock budget for all attempts within this generator, kept under
// what remains of the route's maxDuration after expansion.
const GENERATION_BUDGET_MS = 44_000;

// Matches ASCII control characters (0x00–0x1F) without using a literal
// control char in source. These are invalid raw inside JSON strings.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F]", "g");

// Parses JSON, retrying after replacing raw control characters (e.g. literal
// newlines inside string values, which strict JSON.parse rejects) with spaces.
function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    try {
      return JSON.parse(s.replace(CONTROL_CHARS, " "));
    } catch {
      return undefined;
    }
  }
}

/**
 * Robustly extract a JSON object from model output that may be wrapped in
 * markdown fences, surrounded by prose, or contain raw control characters.
 */
function extractJson(content: string): unknown {
  const trimmed = content.trim();

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    const parsed = tryParse(fenceMatch[1].trim());
    if (parsed !== undefined) return parsed;
  }

  // Grab the outermost {...} block
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const parsed = tryParse(trimmed.slice(first, last + 1));
    if (parsed !== undefined) return parsed;
  }

  // Salvage: output was likely truncated mid-array — recover the complete
  // question objects that did come through.
  const salvaged = salvageQuiz(trimmed);
  if (salvaged !== undefined) return salvaged;

  throw new Error(`Failed to parse JSON from model output: ${trimmed.slice(0, 200)}`);
}

// Recovers a usable quiz from truncated/partial JSON by scanning the
// "questions" array and keeping every complete, parseable object.
function salvageQuiz(content: string): unknown | undefined {
  const titleMatch = content.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const title = titleMatch ? titleMatch[1] : "Generated Quiz";

  const qKey = content.indexOf('"questions"');
  if (qKey === -1) return undefined;
  const arrStart = content.indexOf("[", qKey);
  if (arrStart === -1) return undefined;

  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;

  for (let i = arrStart + 1; i < content.length; i++) {
    const ch = content[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(content.slice(start, i + 1));
        start = -1;
      }
    } else if (ch === "]" && depth === 0) break;
  }

  const questions = objects.map((o) => tryParse(o)).filter((q) => q !== undefined);
  if (questions.length === 0) return undefined;
  return { title, questions };
}

export class HuggingFaceGenerator implements QuizGenerator {
  private apiKey: string;

  constructor() {
    const key = process.env.HF_API_KEY;
    if (!key) throw new Error("HF_API_KEY environment variable is not set");
    this.apiKey = key;
  }

  private async callModel(input: GenerationInput): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(HF_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: HF_MODEL,
          messages: [
            { role: "system", content: generationSystemPrompt(input) },
            { role: "user", content: buildUserMessage(input) },
          ],
          // Scaled to the requested question count rather than the 8192 cap —
          // fewer output tokens means the call returns well inside the timeout.
          max_tokens: maxTokensFor(input.questionCount),
          temperature: 0.4,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`HuggingFace request timed out after ${CALL_TIMEOUT_MS / 1000}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const err = await response.text().catch(() => response.statusText);
      throw new Error(`HuggingFace API error ${response.status}: ${err}`);
    }

    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
      error?: string;
    };
    if (data.error) throw new Error(`HuggingFace API error: ${data.error}`);

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty response from HuggingFace API");
    return content;
  }

  async generate(input: GenerationInput): Promise<GeneratedQuiz> {
    const MAX_ATTEMPTS = 2;
    // Keep total work inside the serverless budget: only start a retry if a
    // full second call could still finish before the function is killed.
    // (A retry therefore only fires when the first attempt failed quickly.)
    const DEADLINE = Date.now() + GENERATION_BUDGET_MS;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1 && Date.now() + CALL_TIMEOUT_MS > DEADLINE) {
        break;
      }
      try {
        // Vary the seed each retry so a malformed generation isn't repeated.
        const content = await this.callModel({
          ...input,
          seed: input.seed + attempt - 1,
        });
        const raw = extractJson(content);
        const parsed = generatedQuizSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(`Schema validation failed: ${parsed.error.message}`);
        }
        if (input.review) {
          return validateReviewQuiz(parsed.data, input.review.concepts);
        }
        parsed.data.questions = parsed.data.questions.slice(0, input.questionCount);
        return parsed.data;
      } catch (err) {
        lastError = err;
        console.warn(`[huggingface] generation attempt ${attempt} failed:`, err);
      }
    }

    throw new Error(
      `Quiz generation failed after ${MAX_ATTEMPTS} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  }
}
