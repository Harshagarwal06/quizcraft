import { z } from "zod";
import { prisma } from "@/lib/db";
import { callStructuredWithFallback } from "@/lib/llm/structured";
import { quoteExistsInChunk } from "@/lib/source/chunk";
import { retrieveChunks } from "@/lib/source/retrieval";
import { parseStringArray } from "./types";

const lessonSchema = z.object({
  title: z.string().min(3),
  sections: z
    .array(
      z.object({
        heading: z.string().min(2),
        body: z.string().min(40),
      })
    )
    .min(2)
    .max(4),
  misconception: z.string().min(20),
  workedExample: z.string(),
  summary: z.string().min(30),
  evidence: z
    .array(
      z.object({
        chunkId: z.string(),
        quote: z.string().min(12),
      })
    )
    .min(1)
    .max(3),
});

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          body: { type: "string" },
        },
        required: ["heading", "body"],
      },
    },
    misconception: { type: "string" },
    workedExample: { type: "string" },
    summary: { type: "string" },
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
    "title",
    "sections",
    "misconception",
    "workedExample",
    "summary",
    "evidence",
  ],
};

export async function generateCoachLesson(actionId: string) {
  const action = await prisma.coachAction.findUnique({
    where: { id: actionId },
    include: {
      studyPlan: {
        include: { concepts: true },
      },
    },
  });
  if (!action) throw new Error("Coach action not found.");
  const conceptKey = parseStringArray(action.conceptKeys)[0];
  const sourceDocumentId = parseStringArray(action.sourceDocumentIds)[0];
  const concept = action.studyPlan.concepts.find(
    (item) => item.conceptKey === conceptKey
  );
  if (!concept || concept.sourceDocumentId !== sourceDocumentId) {
    throw new Error("Lesson concept is not attached to this study plan.");
  }
  const source = await prisma.sourceDocument.findFirst({
    where: {
      id: sourceDocumentId,
      userId: action.studyPlan.userId,
      studyPlanLinks: { some: { studyPlanId: action.studyPlanId } },
    },
    include: { chunks: { orderBy: { ordinal: "asc" } } },
  });
  if (!source) throw new Error("Lesson source is unavailable.");

  const objectives = parseStringArray(concept.objectives);
  const chunks = retrieveChunks(
    source.chunks,
    [concept.label, ...objectives].join(" "),
    parseStringArray(concept.seedChunkIds),
    3
  );
  const response = await callStructuredWithFallback({
    system:
      "You are QuizCraft's source-grounded remediation teacher. Write a concise 3-5 minute university-exam lesson using only the supplied chunks. Do not add outside facts. Include a common misconception, a worked example only when the evidence supports one, a summary, and one to three exact evidence quotes.",
    user: [
      `Concept: ${concept.label}`,
      `Objectives: ${objectives.join("; ") || `Understand ${concept.label}`}`,
      "",
      ...chunks.flatMap((chunk) => [
        `--- CHUNK ${chunk.id} ---`,
        chunk.text,
        "",
      ]),
    ].join("\n"),
    schema: RESPONSE_SCHEMA,
    maxTokens: 2400,
    timeoutMs: 20_000,
  });
  const lesson = lessonSchema.parse(response.raw);
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  for (const evidence of lesson.evidence) {
    const chunk = chunkById.get(evidence.chunkId);
    if (!chunk || !quoteExistsInChunk(evidence.quote, chunk.text)) {
      throw new Error("Lesson evidence did not match its source chunk.");
    }
  }

  return prisma.coachLesson.create({
    data: {
      studyPlanId: action.studyPlanId,
      actionId: action.id,
      title: lesson.title,
      conceptKey,
      sections: JSON.stringify(lesson.sections),
      misconception: lesson.misconception,
      workedExample: lesson.workedExample.trim() || null,
      summary: lesson.summary,
      evidence: {
        create: lesson.evidence.map((evidence, displayOrder) => ({
          sourceChunkId: evidence.chunkId,
          quote: evidence.quote,
          displayOrder,
        })),
      },
    },
  });
}
