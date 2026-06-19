import { normalizeEvidenceText } from "./chunk";

export type RetrievalChunk = {
  id: string;
  text: string;
  normalizedText: string;
  pageStart: number | null;
  section: string | null;
};

const K1 = 1.2;
const B = 0.75;
const MMR_LAMBDA = 0.75;

function tokenize(text: string): string[] {
  return normalizeEvidenceText(text)
    .split(" ")
    .filter((token) => token.length > 1);
}

function cosineLike(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.sqrt(a.size * b.size);
}

export function retrieveChunks(
  chunks: RetrievalChunk[],
  query: string,
  seedChunkIds: string[] = [],
  count = 3
): RetrievalChunk[] {
  if (chunks.length <= count) return chunks;
  const queryTerms = [...new Set(tokenize(query))];
  const docs = chunks.map((chunk) => tokenize(chunk.normalizedText || chunk.text));
  const avgLength =
    docs.reduce((sum, terms) => sum + terms.length, 0) / Math.max(1, docs.length);

  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(
      term,
      docs.filter((tokens) => tokens.includes(term)).length
    );
  }

  const scored = chunks.map((chunk, index) => {
    const tokens = docs[index];
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    let score = 0;
    for (const term of queryTerms) {
      const tf = frequencies.get(term) ?? 0;
      if (tf === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
      const denominator =
        tf + K1 * (1 - B + B * (tokens.length / Math.max(1, avgLength)));
      score += idf * ((tf * (K1 + 1)) / denominator);
    }
    if (seedChunkIds.includes(chunk.id)) score += 1000;
    return { chunk, score, tokens };
  });

  const candidates = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(6, scored.length));
  const selected: typeof candidates = [];

  while (selected.length < Math.min(count, candidates.length)) {
    let best: (typeof candidates)[number] | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of candidates) {
      if (selected.includes(candidate)) continue;
      const diversityPenalty =
        selected.length === 0
          ? 0
          : Math.max(
              ...selected.map((item) =>
                cosineLike(candidate.tokens, item.tokens)
              )
            );
      const locationBonus = selected.some(
        (item) =>
          item.chunk.pageStart === candidate.chunk.pageStart &&
          item.chunk.section === candidate.chunk.section
      )
        ? 0
        : 0.05;
      const mmr =
        MMR_LAMBDA * candidate.score -
        (1 - MMR_LAMBDA) * diversityPenalty +
        locationBonus;
      if (mmr > bestScore) {
        best = candidate;
        bestScore = mmr;
      }
    }
    if (!best) break;
    selected.push(best);
  }

  return selected.map((item) => item.chunk);
}

export function topKeywords(text: string, limit = 8): string[] {
  const stop = new Set([
    "the", "and", "that", "with", "from", "this", "are", "for", "was",
    "were", "into", "their", "which", "when", "where", "have", "has",
  ]);
  const frequencies = new Map<string, number>();
  for (const token of tokenize(text)) {
    if (token.length < 3 || stop.has(token)) continue;
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return [...frequencies.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token);
}
