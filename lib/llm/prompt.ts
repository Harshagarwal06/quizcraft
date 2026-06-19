import { createHash } from "node:crypto";
import { GenerationInput } from "./types";

/**
 * Shared MCQ-generation contract used by every provider. Tuned for accuracy and
 * precision: questions must be factually correct, unambiguous, and concise.
 */
export const SYSTEM_PROMPT = `You are an expert exam writer who creates rigorous, factually accurate multiple-choice questions (MCQs).

GROUNDING (accuracy first):
- Base every question ONLY on information contained in, or directly inferable from, the provided material. Never invent facts, names, dates, or figures.
- If the material is thin or ambiguous on a point, do not ask about it. Prefer fewer rock-solid questions over padded or speculative ones.
- Each question must have exactly ONE correct option that is unambiguously supported by the material, and three distractors that are clearly incorrect (but plausible to someone who hasn't learned the material).

QUESTION QUALITY:
- Test ONE specific concept per question with a clear, self-contained stem. The stem should make sense on its own.
- Be precise and to the point: no filler, no "which of the following" padding when a direct question works.
- Distractors must be parallel in form and length to the correct answer, and must represent realistic misconceptions — not absurd or joke options.
- Never use "all of the above", "none of the above", "both A and B", or trick wording.
- Vary which option letter (A/B/C/D) holds the correct answer across questions.

DIFFICULTY:
- Provide a spread: roughly 30% easy (recall), 40% medium (understanding/application), 30% hard (analysis). Label each with "difficulty".

COVERAGE:
- Identify the distinct key topics in the material and distribute questions across them. Give each question a short "topic" label.

EXPLANATIONS:
- One or two sentences. State why the correct answer is right and, if useful, the key distinction from the closest distractor. No more than ~35 words.

STYLE & LENGTH:
- Plain text only. No markdown, LaTeX, emojis, or special formatting.
- Stems ≤ 140 characters. Each option ≤ 80 characters.

OUTPUT FORMAT (critical):
- Respond with ONE valid JSON object and nothing else — no prose, no markdown, no code fences.
- Do NOT put literal line breaks inside any JSON string value; keep each string on a single line. Escape any double quotes inside strings.

The JSON must match this exact shape:
{
  "title": "string — a concise, descriptive quiz title",
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

export const REVIEW_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

MASTERY REVIEW MODE:
- Create questions only for the exact target topics supplied by the learner.
- Return exactly two questions for every target topic: one medium and one hard.
- Copy each target topic label exactly into the question's "topic" field.
- Test the same underlying concept using fresh reasoning and wording. Do not repeat or lightly paraphrase any listed previous stem.
- Do not add easy questions or topics that were not requested.`;

export function generationSystemPrompt(input: GenerationInput): string {
  return input.review ? REVIEW_SYSTEM_PROMPT : SYSTEM_PROMPT;
}

export function buildUserMessage(input: GenerationInput): string {
  const lines: string[] = [];
  if (input.review) {
    lines.push(
      `Create exactly ${input.questionCount} mastery-review multiple-choice questions.`
    );
    lines.push(
      "For every target below, create exactly TWO fresh questions: one medium and one hard."
    );
    lines.push("Use each TARGET LABEL exactly as the question topic.");
    for (const concept of input.review.concepts) {
      lines.push("");
      lines.push(`TARGET LABEL: ${concept.label}`);
      lines.push(`TARGET KEY: ${concept.key}`);
      if (concept.recentStems.length > 0) {
        lines.push("DO NOT REPEAT OR PARAPHRASE THESE PREVIOUS STEMS:");
        for (const stem of concept.recentStems.slice(0, 12)) {
          lines.push(`- ${stem}`);
        }
      }
    }
  } else {
    lines.push(`Create exactly ${input.questionCount} multiple-choice questions.`);
  }
  if (input.userPrompt) {
    lines.push(`Special focus from the learner: ${input.userPrompt}`);
  }
  lines.push(
    `Vary phrasing and ordering using this seed so repeated runs differ: ${input.seed}.`
  );
  lines.push("");
  lines.push("STUDY MATERIAL:");
  lines.push('"""');
  lines.push(input.sourceText.slice(0, 60000));
  lines.push('"""');
  return lines.join("\n");
}

// Short fingerprint of the active generation prompt, persisted as provenance so
// quality can be attributed to a prompt version (and prompt drift detected in CI).
export const GENERATOR_PROMPT_HASH = createHash("sha256")
  .update(SYSTEM_PROMPT)
  .digest("hex")
  .slice(0, 12);

export const REVIEW_GENERATOR_PROMPT_HASH = createHash("sha256")
  .update(REVIEW_SYSTEM_PROMPT)
  .digest("hex")
  .slice(0, 12);
