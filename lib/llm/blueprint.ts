import { z } from "zod";
import { normalizeConceptKey } from "@/lib/mastery";
import { topKeywords, type RetrievalChunk } from "@/lib/source/retrieval";
import { batchIndexForSlot } from "@/lib/pipeline/batching";
import { callStructuredWithFallback } from "./structured";

const difficultySchema = z.enum(["easy", "medium", "hard"]);

export const blueprintItemSchema = z.object({
  slot: z.number().int().min(0),
  topic: z.string().min(2),
  objective: z.string().min(8),
  difficulty: difficultySchema,
  skillType: z.enum(["recall", "understanding", "application", "analysis"]),
  retrievalQuery: z.string().min(3),
  requiredFacts: z.array(z.string().min(2)).min(1).max(5),
  seedChunkIds: z.array(z.string()).min(1).max(3),
});

const blueprintSchema = z.object({
  title: z.string().min(3),
  items: z.array(blueprintItemSchema),
});

export type BlueprintItem = z.infer<typeof blueprintItemSchema> & {
  conceptKey: string;
  batchIndex: number;
};

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          slot: { type: "integer" },
          topic: { type: "string" },
          objective: { type: "string" },
          difficulty: {
            type: "string",
            enum: ["easy", "medium", "hard"],
          },
          skillType: {
            type: "string",
            enum: ["recall", "understanding", "application", "analysis"],
          },
          retrievalQuery: { type: "string" },
          requiredFacts: { type: "array", items: { type: "string" } },
          seedChunkIds: { type: "array", items: { type: "string" } },
        },
        required: [
          "slot",
          "topic",
          "objective",
          "difficulty",
          "skillType",
          "retrievalQuery",
          "requiredFacts",
          "seedChunkIds",
        ],
      },
    },
  },
  required: ["title", "items"],
};

export function allocateDifficulties(
  count: number
): ("easy" | "medium" | "hard")[] {
  const weights = [
    { difficulty: "easy" as const, weight: 0.3, tie: 1 },
    { difficulty: "medium" as const, weight: 0.4, tie: 2 },
    { difficulty: "hard" as const, weight: 0.3, tie: 0 },
  ];
  const allocations = weights.map((item) => ({
    ...item,
    exact: item.weight * count,
    count: Math.floor(item.weight * count),
  }));
  let remaining = count - allocations.reduce((sum, item) => sum + item.count, 0);
  for (const item of allocations
    .slice()
    .sort(
      (a, b) =>
        b.exact - b.count - (a.exact - a.count) || b.tie - a.tie
    )) {
    if (remaining <= 0) break;
    item.count += 1;
    remaining -= 1;
  }

  const result: ("easy" | "medium" | "hard")[] = [];
  const mutable = new Map(
    allocations.map((item) => [item.difficulty, item.count])
  );
  const cycle = ["medium", "easy", "hard"] as const;
  while (result.length < count) {
    for (const difficulty of cycle) {
      const left = mutable.get(difficulty) ?? 0;
      if (left > 0) {
        result.push(difficulty);
        mutable.set(difficulty, left - 1);
      }
    }
  }
  return result;
}

function sourceMap(chunks: RetrievalChunk[]): string {
  return chunks
    .map((chunk) => {
      const location = chunk.pageStart
        ? `page ${chunk.pageStart}`
        : chunk.section
          ? `section ${chunk.section}`
          : "unlabeled section";
      return [
        `CHUNK ${chunk.id} (${location})`,
        `Keywords: ${topKeywords(chunk.text).join(", ")}`,
        `Excerpt: ${chunk.text.slice(0, 280).replace(/\s+/g, " ")}`,
      ].join("\n");
    })
    .join("\n\n");
}

function validateBlueprint(opts: {
  raw: unknown;
  chunks: RetrievalChunk[];
  count: number;
  difficulties: ("easy" | "medium" | "hard")[];
  userPrompt?: string;
}): { title: string; items: BlueprintItem[] } {
  const parsed = blueprintSchema.parse(opts.raw);
  if (parsed.items.length !== opts.count) {
    throw new Error(`Blueprint returned ${parsed.items.length} items, expected ${opts.count}.`);
  }
  const known = new Set(opts.chunks.map((chunk) => chunk.id));
  const slots = new Set<number>();
  const objectives = new Set<string>();
  for (const item of parsed.items) {
    if (slots.has(item.slot) || item.slot >= opts.count) {
      throw new Error("Blueprint contains duplicate or invalid slots.");
    }
    slots.add(item.slot);
    const objective = item.objective.toLowerCase().replace(/\W+/g, " ").trim();
    if (objectives.has(objective)) {
      throw new Error("Blueprint contains duplicate learning objectives.");
    }
    objectives.add(objective);
    if (item.seedChunkIds.some((id) => !known.has(id))) {
      throw new Error("Blueprint references an unknown source chunk.");
    }
  }

  const ordered = parsed.items.slice().sort((a, b) => a.slot - b.slot);
  if (ordered.some((item, index) => item.difficulty !== opts.difficulties[index])) {
    throw new Error("Blueprint did not preserve the requested difficulty slots.");
  }
  const focusTerms = (opts.userPrompt ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(
      (term) =>
        term.length >= 4 &&
        ![
          "focus",
          "emphasize",
          "questions",
          "question",
          "please",
          "about",
          "chapter",
          "include",
          "especially",
        ].includes(term)
    );
  if (focusTerms.length > 0) {
    const plannedText = ordered
      .flatMap((item) => [
        item.topic,
        item.objective,
        item.retrievalQuery,
        ...item.requiredFacts,
      ])
      .join(" ")
      .toLowerCase();
    if (!focusTerms.some((term) => plannedText.includes(term))) {
      throw new Error("Blueprint does not represent the learner focus.");
    }
  }

  const locations = new Set(
    ordered.flatMap((item) =>
      item.seedChunkIds.map((id) => {
        const chunk = opts.chunks.find((candidate) => candidate.id === id);
        return chunk?.pageStart ?? chunk?.section ?? id;
      })
    )
  );
  const availableLocations = new Set(
    opts.chunks.map((chunk) => chunk.pageStart ?? chunk.section ?? chunk.id)
  );
  if (
    opts.count > 1 &&
    availableLocations.size > 1 &&
    locations.size < Math.min(2, opts.count)
  ) {
    throw new Error("Blueprint coverage is concentrated in one source section.");
  }

  return {
    title: parsed.title,
    items: ordered.map((item) => ({
      ...item,
      conceptKey: normalizeConceptKey(item.topic),
      batchIndex: batchIndexForSlot(item.slot),
    })),
  };
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function supportedFacts(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12);
  return (sentences.length > 0 ? sentences : [text.trim()])
    .slice(0, 2)
    .map((sentence) => sentence.slice(0, 240));
}

function sourceTopic(chunk: RetrievalChunk): string {
  if (chunk.section) return chunk.section;
  const firstSentence = chunk.text.split(/(?<=[.!?])\s+/)[0] ?? chunk.text;
  const words = firstSentence
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (/^(the|a|an)$/i.test(words[0] ?? "")) words.shift();
  const verbIndex = words.findIndex((word) =>
    /^(is|are|was|were|has|have|uses|use|occurs|occur|responds|respond|converts|convert|moves|move|contains|contain|enters|enter|transports|transport)$/i.test(
      word
    )
  );
  const subject = words.slice(
    0,
    verbIndex > 0 ? Math.min(verbIndex, 4) : Math.min(3, words.length)
  );
  return subject.length > 0
    ? titleCase(subject.join(" "))
    : titleCase(topKeywords(chunk.text).slice(0, 2).join(" ")) || "Source";
}

export function buildDeterministicBlueprint(opts: {
  chunks: RetrievalChunk[];
  questionCount: number;
  userPrompt?: string;
}): { title: string; items: BlueprintItem[] } {
  if (opts.chunks.length === 0) {
    throw new Error("The source did not produce any usable chunks.");
  }
  const difficulties = allocateDifficulties(opts.questionCount);
  const firstChunk = opts.chunks[0];
  const titleTopic = sourceTopic(firstChunk);

  return {
    title: `${titleTopic} Quiz`,
    items: Array.from({ length: opts.questionCount }, (_, slot) => {
      const chunk = opts.chunks[slot % opts.chunks.length];
      const keywords = topKeywords(chunk.text).slice(0, 4);
      const topic = sourceTopic(chunk);
      const difficulty = difficulties[slot];
      const skillType =
        difficulty === "easy"
          ? "recall"
          : difficulty === "medium"
            ? "application"
            : "analysis";
      const focus = opts.userPrompt?.trim();
      return {
        slot,
        topic,
        objective: `${
          skillType === "recall"
            ? "Identify"
            : skillType === "application"
              ? "Apply"
              : "Analyze"
        } ${topic} using source-supported facts for item ${slot + 1}`,
        difficulty,
        skillType,
        retrievalQuery: [topic, ...keywords, focus].filter(Boolean).join(" "),
        requiredFacts: supportedFacts(chunk.text),
        seedChunkIds: [chunk.id],
        conceptKey: normalizeConceptKey(topic),
        batchIndex: batchIndexForSlot(slot),
      };
    }),
  };
}

export async function buildQuizBlueprint(opts: {
  chunks: RetrievalChunk[];
  questionCount: number;
  userPrompt?: string;
}): Promise<{
  title: string;
  items: BlueprintItem[];
  provider: string;
  model: string;
}> {
  const difficulties = allocateDifficulties(opts.questionCount);
  const slots = difficulties
    .map((difficulty, slot) => `${slot}: ${difficulty}`)
    .join("\n");
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await callStructuredWithFallback({
        system:
          "You are an exam architect. Plan grounded, non-duplicative MCQs from the supplied source map. Return JSON only. Every item must use its exact assigned slot and difficulty, cite only known chunk IDs, and distribute coverage across the material.",
        user: [
          `Create exactly ${opts.questionCount} blueprint items.`,
          `Learner focus: ${opts.userPrompt || "balanced exam coverage"}`,
          "ASSIGNED SLOTS:",
          slots,
          "",
          "SOURCE MAP:",
          sourceMap(opts.chunks),
          attempt > 0
            ? "\nPrevious output failed validation. Be exact about counts, slots, difficulty, coverage, and chunk IDs."
            : "",
        ].join("\n"),
        schema: RESPONSE_SCHEMA,
        maxTokens: Math.min(5000, 500 + opts.questionCount * 260),
        timeoutMs: 14_000,
      });
      const validated = validateBlueprint({
        raw: response.raw,
        chunks: opts.chunks,
        count: opts.questionCount,
        difficulties,
        userPrompt: opts.userPrompt,
      });
      return {
        ...validated,
        provider: response.provider,
        model: response.model,
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
    "[blueprint] model planning failed; using deterministic source coverage:",
    lastError
  );
  return {
    ...buildDeterministicBlueprint(opts),
    provider: "local",
    model: "deterministic-blueprint-v1",
  };
}
