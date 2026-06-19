import type { ExtractedSource } from "@/lib/extract";

const TARGET_CHARS = 2800;
const OVERLAP_CHARS = 400;
const MIN_CHARS = 24;

export type PreparedChunk = {
  ordinal: number;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  text: string;
  normalizedText: string;
  tokenCount: number;
};

export function normalizeEvidenceText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function splitLongParagraph(paragraph: string): string[] {
  if (paragraph.length <= TARGET_CHARS) return [paragraph];
  const words = paragraph.split(/\s+/);
  const pieces: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > TARGET_CHARS && current) {
      pieces.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function splitPage(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n|\n(?=[A-Z][^\n]{0,80}:?$)/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .flatMap(splitLongParagraph);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > TARGET_CHARS && current) {
      chunks.push(current);
      const overlap = current.slice(-OVERLAP_CHARS).replace(/^\S*\s/, "");
      current = overlap ? `${overlap}\n\n${paragraph}` : paragraph;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function nearDuplicate(a: string, b: string): boolean {
  if (a === b) return true;
  const left = new Set(a.split(" "));
  const right = new Set(b.split(" "));
  if (left.size === 0 || right.size === 0) return false;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / Math.min(left.size, right.size) > 0.92;
}

export function chunkExtractedSource(source: ExtractedSource): PreparedChunk[] {
  const chunks: PreparedChunk[] = [];
  const normalizedSeen: string[] = [];

  for (const page of source.pages) {
    for (const text of splitPage(page.text)) {
      if (text.length < MIN_CHARS) continue;
      const normalizedText = normalizeEvidenceText(text);
      if (
        !normalizedText ||
        normalizedSeen.some((existing) => nearDuplicate(existing, normalizedText))
      ) {
        continue;
      }
      normalizedSeen.push(normalizedText);
      chunks.push({
        ordinal: chunks.length,
        pageStart: page.pageNumber,
        pageEnd: page.pageNumber,
        section: page.section ?? null,
        text,
        normalizedText,
        tokenCount: estimateTokens(text),
      });
    }
  }

  return chunks;
}

export function quoteExistsInChunk(quote: string, chunkText: string): boolean {
  const normalizedQuote = normalizeEvidenceText(quote);
  return (
    normalizedQuote.length >= 12 &&
    normalizeEvidenceText(chunkText).includes(normalizedQuote)
  );
}
