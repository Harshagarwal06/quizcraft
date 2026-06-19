import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import type { ExtractedSource } from "@/lib/extract";
import { chunkExtractedSource, normalizeEvidenceText } from "./chunk";

export type GroundedReference = {
  title: string;
  url: string;
  domain: string;
  authority: "authoritative" | "established" | "rejected";
  supportedTexts?: string[];
};

export async function persistSourceDocument(opts: {
  userId: string;
  kind: "pdf" | "notes" | "web";
  title: string;
  extracted: ExtractedSource;
  originUrl?: string;
  references?: GroundedReference[];
}) {
  const contentHash = createHash("sha256")
    .update(`${opts.kind}\0${opts.originUrl ?? ""}\0${opts.extracted.fullText}`)
    .digest("hex");
  const preparedChunks = chunkExtractedSource(opts.extracted);
  if (preparedChunks.length === 0) {
    throw new Error("No usable source chunks could be extracted.");
  }

  const existing = await prisma.sourceDocument.findUnique({
    where: {
      userId_contentHash: {
        userId: opts.userId,
        contentHash,
      },
    },
    include: {
      chunks: {
        orderBy: { ordinal: "asc" },
        include: {
          references: { include: { sourceReference: true } },
        },
      },
      references: true,
    },
  });
  if (existing) return existing;

  return prisma.sourceDocument.create({
    data: {
      userId: opts.userId,
      kind: opts.kind,
      title: opts.title,
      fullText: opts.extracted.fullText,
      contentHash,
      originUrl: opts.originUrl,
      extractionMetadata: JSON.stringify(opts.extracted.metadata ?? {}),
      references: {
        create: (opts.references ?? []).map((reference) => ({
          title: reference.title,
          url: reference.url,
          domain: reference.domain,
          authority: reference.authority,
        })),
      },
      chunks: {
        create: preparedChunks.map((chunk) => ({
          ordinal: chunk.ordinal,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          section: chunk.section,
          text: chunk.text,
          normalizedText: chunk.normalizedText,
          tokenCount: chunk.tokenCount,
        })),
      },
    },
    include: {
      chunks: {
        orderBy: { ordinal: "asc" },
        include: {
          references: { include: { sourceReference: true } },
        },
      },
      references: true,
    },
  }).then(async (document) => {
    if (document.references.length > 0) {
      const inputByUrl = new Map(
        (opts.references ?? []).map((reference) => [reference.url, reference])
      );
      const links = document.chunks.flatMap((chunk) =>
        document.references.flatMap((reference) => {
          const supportedTexts =
            inputByUrl.get(reference.url)?.supportedTexts ?? [];
          const normalizedChunk = chunk.normalizedText;
          const matches = supportedTexts.some((text) => {
            const normalizedSupport = normalizeEvidenceText(text);
            return (
              normalizedSupport.length > 0 &&
              (normalizedChunk.includes(normalizedSupport) ||
                normalizedSupport.includes(normalizedChunk))
            );
          });
          return matches
            ? [
                {
                  sourceChunkId: chunk.id,
                  sourceReferenceId: reference.id,
                },
              ]
            : [];
        })
      );
      if (links.length > 0) {
        await prisma.chunkReference.createMany({ data: links });
      }
    }
    return prisma.sourceDocument.findUniqueOrThrow({
      where: { id: document.id },
      include: {
        chunks: {
          orderBy: { ordinal: "asc" },
          include: {
            references: { include: { sourceReference: true } },
          },
        },
        references: true,
      },
    });
  });
}
