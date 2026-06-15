import { generatedQuizSchema, GeneratedQuiz, GenerationInput, QuizGenerator } from "./types";

const HF_MODEL = "Qwen/Qwen2.5-72B-Instruct";
// HuggingFace Inference Providers router (OpenAI-compatible)
const HF_ENDPOINT = "https://router.huggingface.co/v1/chat/completions";

const SYSTEM_PROMPT = `You are an expert educator and quiz designer. Your task is to generate high-quality multiple-choice questions (MCQs) from provided study material.

REQUIREMENTS:
1. DIFFICULTY MIX: Aim for ~30% easy, ~40% medium, ~30% hard questions. Label each question clearly.
2. COVERAGE: First identify the key topics in the material, then distribute questions across all of them. Include a "topic" field per question.
3. ANSWER OPTIONS: Always provide exactly 4 options (A, B, C, D). Randomize which letter holds the correct answer. Options must be plausible distractors — not obviously wrong.
4. EXPLANATIONS: Every question must include a brief explanation of why the correct answer is right. Keep it under 35 words — be concise to keep the response compact.
5. QUESTION STEMS: Clear, unambiguous, testing understanding not just recall. No "all of the above" or "none of the above."
6. FRESHNESS: Use the provided seed value to vary phrasing and question angles so repeated generations differ.
7. FORMAT: Plain text only — no markdown, LaTeX, or special characters. Stems ≤120 chars, option text ≤80 chars each.
8. TITLE: Generate a descriptive title for the quiz based on the content.

CRITICAL OUTPUT RULES:
- Respond with a SINGLE valid JSON object and nothing else — no prose, no markdown, no code fences.
- Do NOT put literal line breaks inside any JSON string value; keep each string on one line.
- Escape any double quotes inside strings.

The JSON must match this exact shape:
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
        max_tokens: 8192, // provider hard cap for this model
        temperature: 0.4,
      }),
    });

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
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
