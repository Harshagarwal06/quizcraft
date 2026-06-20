import test from "node:test";
import assert from "node:assert/strict";
import { extractSource } from "../lib/extract";
import {
  chunkExtractedSource,
  quoteExistsInChunk,
} from "../lib/source/chunk";
import { retrieveChunks } from "../lib/source/retrieval";
import {
  allocateDifficulties,
  buildDeterministicBlueprint,
} from "../lib/llm/blueprint";
import { shuffleQuizOptions } from "../lib/llm/shuffle";
import { reconcileVerdicts } from "../lib/llm/verify";
import { providerVerificationResultSchema } from "../lib/llm/verify/types";
import {
  classifyAuthority,
  groundedSourceFromMetadata,
} from "../lib/source/web-grounding";
import {
  buildDeterministicEvidenceQuestions,
  validateGeneratedBatch,
  type EvidenceBlueprintItem,
} from "../lib/pipeline/evidence-generation";

test("note extraction preserves detected sections", async () => {
  const source = await extractSource({
    type: "text",
    content:
      "# Cell Cycle\nThe cell cycle contains G1, S, G2, and M phases.\n\n## Checkpoints\nThe G1 checkpoint evaluates nutrients and DNA damage.",
  });
  assert.equal(source.pages.length, 2);
  assert.equal(source.pages[0].section, "Cell Cycle");
  assert.equal(source.pages[1].section, "Checkpoints");
});

test("chunking never crosses page boundaries and validates exact quotes", () => {
  const chunks = chunkExtractedSource({
    pages: [
      { pageNumber: 1, text: "A ".repeat(800) + "Page one fact." },
      { pageNumber: 2, text: "B ".repeat(800) + "Page two fact." },
    ],
    fullText: "",
  });
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.pageStart === chunk.pageEnd));
  assert.equal(
    quoteExistsInChunk("Page one fact.", chunks.find((chunk) => chunk.pageStart === 1)?.text ?? ""),
    true
  );
  assert.equal(quoteExistsInChunk("Invented quote", chunks[0].text), false);
});

test("BM25 retrieval preserves a seed chunk and favors relevant evidence", () => {
  const chunks = [
    {
      id: "photosynthesis",
      text: "Chlorophyll absorbs blue and red light during photosynthesis.",
      normalizedText: "chlorophyll absorbs blue and red light during photosynthesis",
      pageStart: 1,
      section: null,
    },
    {
      id: "database",
      text: "A B-tree index supports equality and range queries.",
      normalizedText: "a b tree index supports equality and range queries",
      pageStart: 2,
      section: null,
    },
    {
      id: "seed",
      text: "The Calvin cycle uses ATP and NADPH.",
      normalizedText: "the calvin cycle uses atp and nadph",
      pageStart: 3,
      section: null,
    },
    {
      id: "other",
      text: "HTTP caching can return a 304 response.",
      normalizedText: "http caching can return a 304 response",
      pageStart: 4,
      section: null,
    },
  ];
  const results = retrieveChunks(
    chunks,
    "chlorophyll photosynthesis light",
    ["seed"],
    3
  );
  assert.ok(results.some((chunk) => chunk.id === "seed"));
  assert.ok(results.some((chunk) => chunk.id === "photosynthesis"));
});

test("difficulty allocation uses exact largest-remainder targets", () => {
  assert.deepEqual(allocateDifficulties(3).sort(), ["easy", "hard", "medium"]);
  const ten = allocateDifficulties(10);
  assert.equal(ten.filter((value) => value === "easy").length, 3);
  assert.equal(ten.filter((value) => value === "medium").length, 4);
  assert.equal(ten.filter((value) => value === "hard").length, 3);
});

test("deterministic blueprint fallback preserves count, slots, and source coverage", () => {
  const blueprint = buildDeterministicBlueprint({
    questionCount: 5,
    userPrompt: "emphasize transport",
    chunks: [
      {
        id: "membrane",
        text: "Cell membranes contain phospholipids and proteins. Transport proteins move ions across the membrane.",
        normalizedText:
          "cell membranes contain phospholipids and proteins transport proteins move ions across the membrane",
        pageStart: 1,
        section: "Cell Membranes",
      },
      {
        id: "osmosis",
        text: "Osmosis is the movement of water across a selectively permeable membrane.",
        normalizedText:
          "osmosis is the movement of water across a selectively permeable membrane",
        pageStart: 2,
        section: "Osmosis",
      },
    ],
  });
  assert.equal(blueprint.items.length, 5);
  assert.deepEqual(
    blueprint.items.map((item) => item.slot),
    [0, 1, 2, 3, 4]
  );
  assert.deepEqual(
    blueprint.items.map((item) => item.difficulty),
    allocateDifficulties(5)
  );
  assert.deepEqual(
    new Set(blueprint.items.flatMap((item) => item.seedChunkIds)),
    new Set(["membrane", "osmosis"])
  );
  assert.ok(
    blueprint.items.every((item) =>
      item.retrievalQuery.includes("emphasize transport")
    )
  );
});

test("option shuffling keeps rationales attached to original option text", () => {
  const result = shuffleQuizOptions({
    title: "Quiz",
    questions: [
      {
        stem: "Question",
        options: [
          { id: "A", text: "Alpha" },
          { id: "B", text: "Beta" },
          { id: "C", text: "Gamma" },
          { id: "D", text: "Delta" },
        ],
        correctOptionId: "C",
        explanation: "Gamma is correct.",
        optionExplanations: {
          A: "Why Alpha",
          B: "Why Beta",
          C: "Why Gamma",
          D: "Why Delta",
        },
        difficulty: "medium",
        topic: "Letters",
      },
    ],
  }).questions[0];
  for (const option of result.options) {
    assert.equal(
      result.optionExplanations?.[option.id],
      `Why ${option.text}`
    );
  }
  assert.equal(
    result.options.find((option) => option.id === result.correctOptionId)?.text,
    "Gamma"
  );
});

test("verifier reconciliation marks missing and duplicate indexes as affected", () => {
  const verdict = {
    index: 0,
    grounded: true,
    answerSupported: true,
    uniqueAnswer: true,
    distractorsValid: true,
    evidenceValid: true,
    correctOptionId: "A" as const,
    reasons: ["ok"],
    complete: true,
  };
  const result = reconcileVerdicts(
    [verdict, { ...verdict, index: 0 }, { ...verdict, index: 2 }],
    3
  );
  assert.deepEqual(result.affected, [0, 1]);
  assert.equal(result.valid.has(2), true);
});

test("live verifier responses cannot omit evidence validity", () => {
  const missingEvidenceVerdict = {
    verdicts: [
      {
        index: 0,
        grounded: true,
        answerSupported: true,
        uniqueAnswer: true,
        distractorsValid: true,
        correctOptionId: "A",
        reasons: ["ok"],
      },
    ],
  };
  assert.equal(
    providerVerificationResultSchema.safeParse(missingEvidenceVerdict).success,
    false
  );
});

test("evidence generation rejects topic drift and non-matching quotes", () => {
  const item: EvidenceBlueprintItem = {
    id: "item-1",
    slot: 0,
    topic: "Photosynthesis",
    objective: "Explain chlorophyll absorption",
    difficulty: "medium",
    skillType: "understanding",
    retrievalQuery: "chlorophyll absorption",
    requiredFacts: ["Chlorophyll absorbs blue and red light"],
    chunks: [
      {
        id: "chunk-1",
        text: "Chlorophyll absorbs light most strongly in blue and red wavelengths.",
        normalizedText:
          "chlorophyll absorbs light most strongly in blue and red wavelengths",
        pageStart: 2,
        section: null,
      },
    ],
  };
  const valid = {
    questions: [
      {
        blueprintItemId: "item-1",
        stem: "Which wavelengths does chlorophyll absorb most strongly?",
        options: [
          { id: "A", text: "Blue and red" },
          { id: "B", text: "Green only" },
          { id: "C", text: "Infrared only" },
          { id: "D", text: "Ultraviolet only" },
        ],
        correctOptionId: "A",
        explanation: "The evidence identifies blue and red wavelengths.",
        optionExplanations: {
          A: "Matches the evidence.",
          B: "Green is largely reflected.",
          C: "Infrared is not stated.",
          D: "Ultraviolet is not stated.",
        },
        difficulty: "medium",
        topic: "Photosynthesis",
        evidence: [
          {
            chunkId: "chunk-1",
            quote:
              "Chlorophyll absorbs light most strongly in blue and red wavelengths.",
          },
        ],
      },
    ],
  };
  assert.equal(
    validateGeneratedBatch({ raw: valid, items: [item], previousStems: [] })
      .length,
    1
  );
  const invalid = structuredClone(valid);
  invalid.questions[0].evidence[0].quote = "An unsupported invented statement.";
  assert.throws(
    () =>
      validateGeneratedBatch({ raw: invalid, items: [item], previousStems: [] }),
    /does not match/
  );
});

test("deterministic evidence fallback creates exact cited questions", () => {
  const item: EvidenceBlueprintItem = {
    id: "item-1",
    slot: 0,
    topic: "Osmosis",
    objective: "Apply osmosis to a source-supported example",
    difficulty: "medium",
    skillType: "application",
    retrievalQuery: "osmosis water membrane",
    requiredFacts: ["Osmosis moves water across a membrane."],
    chunks: [
      {
        id: "chunk-1",
        text: "Osmosis moves water across a selectively permeable membrane.",
        normalizedText:
          "osmosis moves water across a selectively permeable membrane",
        pageStart: 1,
        section: "Osmosis",
      },
    ],
  };
  const questions = buildDeterministicEvidenceQuestions({
    items: [item],
    previousStems: [],
  });
  assert.equal(questions.length, 1);
  assert.equal(questions[0].blueprintItemId, item.id);
  assert.equal(questions[0].topic, item.topic);
  assert.equal(
    questions[0].evidence?.[0].quote,
    "Osmosis moves water across a selectively permeable membrane."
  );
  assert.equal(
    questions[0].options.find(
      (option) => option.id === questions[0].correctOptionId
    )?.text,
    questions[0].evidence?.[0].quote
  );
});

test("web source policy rejects forums and recognizes authorities", () => {
  assert.equal(classifyAuthority("reddit.com"), "rejected");
  assert.equal(classifyAuthority("example.edu"), "authoritative");
  assert.equal(classifyAuthority("who.int"), "authoritative");
  assert.equal(classifyAuthority("example.com"), "established");
});

test("web grounding keeps only supported passages and maps their sources", () => {
  const brief =
    "The kidney filters plasma at the glomerulus. Tubules then reabsorb useful solutes.";
  const result = groundedSourceFromMetadata("Renal physiology", brief, {
    groundingChunks: [
      {
        web: {
          uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/example",
          title: "nih.gov",
        },
      },
      { web: { uri: "https://example.edu/tubules", title: "University notes" } },
    ],
    groundingSupports: [
      {
        segment: { text: "The kidney filters plasma at the glomerulus." },
        groundingChunkIndices: [0],
      },
      {
        segment: { text: "Tubules then reabsorb useful solutes." },
        groundingChunkIndices: [1],
      },
    ],
  });
  assert.equal(result.extracted.pages.length, 2);
  assert.equal(result.references[0].domain, "nih.gov");
  assert.equal(result.references[0].authority, "authoritative");
  assert.equal(result.references[0].supportedTexts?.length, 1);
  assert.equal(result.references[1].supportedTexts?.length, 1);
  assert.equal(chunkExtractedSource(result.extracted).length, 2);
  assert.doesNotMatch(result.extracted.fullText, /unsupported/i);
});
