import { z } from "zod";
import { createHash } from "node:crypto";
import type { GeneratedQuestion } from "@/lib/llm/types";
import { generatedQuestionSchema } from "@/lib/llm/types";
import { shuffleQuizOptions } from "@/lib/llm/shuffle";
import {
  callStructuredWithFallback,
  type StructuredProvider,
} from "@/lib/llm/structured";
import { normalizeEvidenceText, quoteExistsInChunk } from "@/lib/source/chunk";
import {
  topKeywords,
  type RetrievalChunk,
} from "@/lib/source/retrieval";

const EVIDENCE_SYSTEM_PROMPT =
  "You are a rigorous university exam writer. Return JSON only. " +
  "Write one unambiguous MCQ per blueprint item, grounded exclusively in that item's evidence chunks. " +
  "Exactly one option must be fully provable from the evidence; the other three must be clearly refuted by that same evidence — plausible misconceptions a real student might hold, never absurd or off-topic. " +
  "Keep all four options mutually exclusive and parallel in length and grammar so the answer is never given away by phrasing. " +
  "Write self-contained stems: never refer to \"the passage\", \"the text\", \"the source\", or \"the chunk\", and never use \"all of the above\" or \"none of the above\". " +
  "Every option needs a concise explanation stating why it is correct or which specific misconception it represents, and every question needs one or two exact support quotes copied verbatim from its named chunk.";

export const EVIDENCE_GENERATOR_PROMPT_HASH = createHash("sha256")
  .update(EVIDENCE_SYSTEM_PROMPT)
  .digest("hex")
  .slice(0, 12);

export type EvidenceBlueprintItem = {
  id: string;
  slot: number;
  topic: string;
  objective: string;
  difficulty: "easy" | "medium" | "hard";
  skillType: string;
  retrievalQuery: string;
  requiredFacts: string[];
  chunks: RetrievalChunk[];
};

const evidenceQuestionSchema = generatedQuestionSchema.extend({
  blueprintItemId: z.string(),
  optionExplanations: z.object({
    A: z.string().min(2),
    B: z.string().min(2),
    C: z.string().min(2),
    D: z.string().min(2),
  }),
  evidence: z
    .array(
      z.object({
        chunkId: z.string(),
        quote: z.string().min(12),
      })
    )
    .min(1)
    .max(2),
});

const batchSchema = z.object({
  questions: z.array(evidenceQuestionSchema),
});

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          blueprintItemId: { type: "string" },
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
          correctOptionId: {
            type: "string",
            enum: ["A", "B", "C", "D"],
          },
          explanation: { type: "string" },
          optionExplanations: {
            type: "object",
            properties: {
              A: { type: "string" },
              B: { type: "string" },
              C: { type: "string" },
              D: { type: "string" },
            },
            required: ["A", "B", "C", "D"],
          },
          difficulty: {
            type: "string",
            enum: ["easy", "medium", "hard"],
          },
          topic: { type: "string" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: {
                chunkId: { type: "string" },
                quote: { type: "string" },
              },
              required: ["chunkId", "quote"],
            },
          },
        },
        required: [
          "blueprintItemId",
          "stem",
          "options",
          "correctOptionId",
          "explanation",
          "optionExplanations",
          "difficulty",
          "topic",
          "evidence",
        ],
      },
    },
  },
  required: ["questions"],
};

function buildBatchPrompt(items: EvidenceBlueprintItem[]): string {
  const lines = [
    `Create exactly ${items.length} multiple-choice questions, one for each blueprint item.`,
    "Follow every blueprint item exactly. Use only its evidence chunks.",
    "Exactly one option is correct and provable from the evidence; the other three must be refuted by it.",
    "Give all four options distinct text, parallel in length and grammar; never signal the answer through wording.",
    "Write a self-contained stem — do not mention the source, passage, text, or chunk.",
    "Evidence quotes must be copied verbatim from the named chunk.",
    "Each distractor explanation must state the specific misconception or source conflict.",
  ];
  for (const item of items) {
    lines.push(
      "",
      `BLUEPRINT ITEM ${item.id}`,
      `Topic: ${item.topic}`,
      `Difficulty: ${item.difficulty}`,
      `Skill: ${item.skillType}`,
      `Objective: ${item.objective}`,
      `Required facts: ${item.requiredFacts.join("; ")}`,
      "EVIDENCE CHUNKS:"
    );
    for (const chunk of item.chunks) {
      lines.push(`--- CHUNK ${chunk.id} ---`, chunk.text);
    }
  }
  return lines.join("\n");
}

function exactSupportQuote(chunkText: string, offset: number): string {
  const sentences = chunkText
    .split(/(?<=[.!?])\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length >= 12);
  const quote =
    sentences[offset % Math.max(1, sentences.length)] ?? chunkText.trim();
  if (quote.length < 12) {
    throw new Error("The evidence chunk is too short for a supported question.");
  }
  return quote.slice(0, 320);
}

export function buildDeterministicEvidenceQuestions(opts: {
  items: EvidenceBlueprintItem[];
  previousStems: string[];
}): GeneratedQuestion[] {
  const raw = {
    questions: opts.items.map((item) => {
      const chunk = item.chunks[0];
      if (!chunk) {
        throw new Error(`Blueprint item ${item.id} has no evidence chunk.`);
      }
      const quote = exactSupportQuote(chunk.text, item.slot);
      const cue =
        topKeywords(quote)
          .slice(0, 2)
          .map((word) => word.replace(/\b\w/g, (letter) => letter.toUpperCase()))
          .join(" ") || item.topic;
      return {
        blueprintItemId: item.id,
        stem: `Which option accurately reproduces the source's statement about ${cue} without changing its meaning?`,
        options: [
          { id: "A" as const, text: quote },
          {
            id: "B" as const,
            text: `The source provides no information about ${cue}.`,
          },
          {
            id: "C" as const,
            text: `The source says ${cue} is unrelated to ${item.topic}.`,
          },
          {
            id: "D" as const,
            text: `The source says this statement is incorrect: ${quote}`,
          },
        ],
        correctOptionId: "A" as const,
        explanation:
          "The correct option restates the exact supporting passage; the other options add claims that the source does not support.",
        optionExplanations: {
          A: "This statement is copied from the cited source passage.",
          B: "The cited passage directly provides information about this subject.",
          C: "The passage connects the subject to the source topic rather than calling it unrelated.",
          D: "The cited passage presents this statement as supported, not incorrect.",
        },
        difficulty: item.difficulty,
        topic: item.topic,
        evidence: [{ chunkId: chunk.id, quote }],
      };
    }),
  };
  return validateGeneratedBatch({
    raw,
    items: opts.items,
    previousStems: opts.previousStems,
  });
}

export function validateGeneratedBatch(opts: {
  raw: unknown;
  items: EvidenceBlueprintItem[];
  previousStems: string[];
}): GeneratedQuestion[] {
  const parsed = batchSchema.parse(opts.raw);
  if (parsed.questions.length !== opts.items.length) {
    throw new Error(
      `Generated ${parsed.questions.length} questions for ${opts.items.length} blueprint items.`
    );
  }
  const byId = new Map(opts.items.map((item) => [item.id, item]));
  const seenItems = new Set<string>();
  const seenStems = new Set(opts.previousStems.map(normalizeEvidenceText));

  for (const question of parsed.questions) {
    const item = byId.get(question.blueprintItemId);
    if (!item || seenItems.has(question.blueprintItemId)) {
      throw new Error("Generated questions contain an unknown or duplicate blueprint item.");
    }
    seenItems.add(question.blueprintItemId);
    if (question.topic !== item.topic || question.difficulty !== item.difficulty) {
      throw new Error("Generated question drifted from its blueprint topic or difficulty.");
    }
    const stem = normalizeEvidenceText(question.stem);
    if (seenStems.has(stem)) {
      throw new Error("Generated question repeats an existing stem.");
    }
    seenStems.add(stem);

    // Cheap structural gate: catch malformed MCQs here so the generate retry
    // loop fixes them, instead of spending a (slower) verifier call to discover
    // the same defect. The Zod schema only guarantees four options exist.
    const optionIds = question.options.map((option) => option.id);
    if (new Set(optionIds).size !== 4) {
      throw new Error("Generated question does not have four distinct options A–D.");
    }
    if (!optionIds.includes(question.correctOptionId)) {
      throw new Error("Generated question's correct option is not one of its options.");
    }
    const optionTexts = question.options.map((option) =>
      normalizeEvidenceText(option.text)
    );
    if (optionTexts.some((text) => text.length === 0)) {
      throw new Error("Generated question has an empty option.");
    }
    if (new Set(optionTexts).size !== optionTexts.length) {
      throw new Error("Generated question has duplicate option text.");
    }

    const chunks = new Map(item.chunks.map((chunk) => [chunk.id, chunk]));
    for (const evidence of question.evidence) {
      const chunk = chunks.get(evidence.chunkId);
      if (!chunk || !quoteExistsInChunk(evidence.quote, chunk.text)) {
        throw new Error("Generated evidence does not match its source chunk.");
      }
    }
  }

  const shuffled = shuffleQuizOptions({
    title: "Evidence batch",
    questions: parsed.questions,
  });
  return shuffled.questions;
}

export async function generateEvidenceBatch(opts: {
  items: EvidenceBlueprintItem[];
  previousStems: string[];
  preferredProvider?: StructuredProvider;
}): Promise<{
  questions: GeneratedQuestion[];
  provider: string;
  model: string;
  retryCount: number;
}> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await callStructuredWithFallback({
        system: EVIDENCE_SYSTEM_PROMPT,
        user:
          buildBatchPrompt(opts.items) +
          (attempt > 0
            ? "\nThe prior response failed validation. Preserve exact item IDs, topics, difficulties, quotes, and counts."
            : ""),
        schema: RESPONSE_SCHEMA,
        maxTokens: Math.min(2_200, 450 + opts.items.length * 450),
        timeoutMs: 25_000,
        preferredProvider: opts.preferredProvider,
      });
      return {
        questions: validateGeneratedBatch({
          raw: response.raw,
          items: opts.items,
          previousStems: opts.previousStems,
        }),
        provider: response.provider,
        model: response.model,
        retryCount: attempt,
      };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (
        /timed out|quota|API error (?:401|403|429|5\d\d)|No configured structured-output provider/i.test(
          message
        )
      ) {
        break;
      }
    }
  }
  console.warn(
    "[evidence] model generation failed; using deterministic cited questions:",
    lastError
  );
  return {
    questions: buildDeterministicEvidenceQuestions(opts),
    provider: "local",
    model: "deterministic-evidence-v1",
    retryCount: 0,
  };
}
