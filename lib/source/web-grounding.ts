import type { ExtractedSource } from "@/lib/extract";
import type { GroundedReference } from "./store";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 18_000;
const REJECTED_DOMAINS = [
  "reddit.com",
  "quora.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
];
const DEFAULT_TRUSTED = [
  "who.int",
  "nih.gov",
  "cdc.gov",
  "nasa.gov",
  "openstax.org",
  "britannica.com",
  "developer.mozilla.org",
  "w3.org",
  "ietf.org",
  "docs.python.org",
  "microsoft.com",
  "apple.com",
  "google.com",
];
const GROUNDING_PROXY_DOMAINS = new Set([
  "vertexaisearch.cloud.google.com",
]);

type GroundingChunk = {
  web?: { uri?: string; title?: string };
};

export type GroundingMetadata = {
  groundingChunks?: GroundingChunk[];
  groundingSupports?: {
    segment?: {
      startIndex?: number;
      endIndex?: number;
      text?: string;
    };
    groundingChunkIndices?: number[];
  }[];
};

type GeminiGroundedResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    groundingMetadata?: GroundingMetadata;
  }[];
};

export type WebGroundingErrorCode =
  | "disabled"
  | "provider_unavailable"
  | "insufficient_sources";

export class WebGroundingError extends Error {
  constructor(
    public readonly code: WebGroundingErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WebGroundingError";
  }
}

function unwrapUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of ["url", "q", "target", "redirect"]) {
      const nested = url.searchParams.get(key);
      if (nested?.startsWith("http")) return nested;
    }
    return raw;
  } catch {
    return raw;
  }
}

function domainFor(raw: string): string {
  try {
    return new URL(unwrapUrl(raw)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function domainFromTitle(title: string | undefined): string {
  const value = title?.trim().toLowerCase() ?? "";
  if (!value) return "";
  const asUrl = value.startsWith("http") ? domainFor(value) : "";
  if (asUrl) return asUrl;
  const hostname = value.replace(/^www\./, "");
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(hostname) ? hostname : "";
}

function matchesDomain(domain: string, expected: string): boolean {
  return domain === expected || domain.endsWith(`.${expected}`);
}

export function classifyAuthority(
  domain: string
): GroundedReference["authority"] {
  if (!domain || REJECTED_DOMAINS.some((item) => matchesDomain(domain, item))) {
    return "rejected";
  }
  const extra = (process.env.TRUSTED_SOURCE_DOMAINS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (
    domain.endsWith(".gov") ||
    domain.endsWith(".edu") ||
    [...DEFAULT_TRUSTED, ...extra].some((item) => matchesDomain(domain, item))
  ) {
    return "authoritative";
  }
  return "established";
}

function supportingPassage(
  brief: string,
  support: NonNullable<GroundingMetadata["groundingSupports"]>[number]
): string {
  const supplied = support.segment?.text?.trim();
  if (supplied) return supplied;
  const start = support.segment?.startIndex;
  const end = support.segment?.endIndex;
  if (
    typeof start === "number" &&
    typeof end === "number" &&
    start >= 0 &&
    end > start
  ) {
    return brief.slice(start, end).trim();
  }
  return "";
}

function referencesFrom(
  brief: string,
  metadata: GroundingMetadata | undefined
): GroundedReference[] {
  const byUrl = new Map<string, GroundedReference>();
  const byChunkIndex = new Map<number, GroundedReference>();
  for (const [index, chunk] of (metadata?.groundingChunks ?? []).entries()) {
    const rawUrl = chunk.web?.uri;
    if (!rawUrl) continue;
    const url = unwrapUrl(rawUrl);
    const urlDomain = domainFor(url);
    const domain = GROUNDING_PROXY_DOMAINS.has(urlDomain)
      ? domainFromTitle(chunk.web?.title) || urlDomain
      : urlDomain;
    const authority = classifyAuthority(domain);
    if (authority === "rejected") continue;
    const reference =
      byUrl.get(url) ??
      {
        title: chunk.web?.title?.trim() || domain || "Source",
        url,
        domain,
        authority,
        supportedTexts: [],
      };
    byUrl.set(url, reference);
    byChunkIndex.set(index, reference);
  }
  for (const support of metadata?.groundingSupports ?? []) {
    const passage = supportingPassage(brief, support);
    if (!passage) continue;
    for (const index of support.groundingChunkIndices ?? []) {
      const reference = byChunkIndex.get(index);
      if (
        reference &&
        !reference.supportedTexts?.some((text) => text === passage)
      ) {
        reference.supportedTexts = [...(reference.supportedTexts ?? []), passage];
      }
    }
  }
  return [...byUrl.values()];
}

function validateReferences(references: GroundedReference[]): boolean {
  const supportingReferences = references.filter(
    (reference) => (reference.supportedTexts?.length ?? 0) > 0
  );
  const domains = new Set(
    supportingReferences.map((reference) => reference.domain)
  );
  return (
    domains.size >= 2 &&
    supportingReferences.some(
      (reference) => reference.authority === "authoritative"
    )
  );
}

export function groundedSourceFromMetadata(
  topic: string,
  brief: string,
  metadata: GroundingMetadata | undefined
): {
  extracted: ExtractedSource;
  references: GroundedReference[];
} {
  const references = referencesFrom(brief, metadata);
  const passages: string[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    for (const passage of reference.supportedTexts ?? []) {
      const key = passage.replace(/\s+/g, " ").trim().toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        passages.push(passage);
      }
    }
  }
  return {
    extracted: {
      title: topic,
      pages: passages.map((text, index) => ({
        pageNumber: null,
        section: `Excerpt ${index + 1}`,
        text,
      })),
      fullText: passages.join("\n\n"),
      metadata: {
        grounded: true,
        sourceDomains: [...new Set(references.map((item) => item.domain))],
        supportedPassageCount: passages.length,
      },
    },
    references,
  };
}

async function groundedCall(
  topic: string,
  userPrompt: string | undefined,
  strict: boolean
): Promise<{ text: string; metadata: GroundingMetadata | undefined }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new WebGroundingError(
      "provider_unavailable",
      "GEMINI_API_KEY is required for prompt grounding."
    );
  }
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const authorityInstruction = strict
    ? "Use only authoritative sources such as government agencies, universities, standards bodies, official documentation, and established reference publishers."
    : "Prefer authoritative sources such as government agencies, universities, standards bodies, official documentation, and established reference publishers.";

  try {
    const response = await fetch(
      `${ENDPOINT}/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: `Research a university-exam study topic using Google Search. Produce a dense factual brief with definitions, mechanisms, comparisons, examples, and common misconceptions. ${authorityInstruction} Do not include unsupported claims.`,
              },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `Topic: ${topic}\nLearner focus: ${userPrompt || "general exam coverage"}`,
                },
              ],
            },
          ],
          tools: [{ google_search: {} }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2200,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      let providerMessage = response.statusText;
      try {
        const parsed = JSON.parse(detail) as { error?: { message?: string } };
        providerMessage =
          parsed.error?.message?.split("\n")[0]?.trim() || providerMessage;
      } catch {
        providerMessage = detail.slice(0, 300) || providerMessage;
      }
      throw new WebGroundingError(
        "provider_unavailable",
        `Grounded research provider failed (${response.status}): ${providerMessage}`
      );
    }
    const data = (await response.json()) as GeminiGroundedResponse;
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new WebGroundingError(
        "provider_unavailable",
        "Grounded research returned no brief."
      );
    }
    return { text, metadata: candidate?.groundingMetadata };
  } finally {
    clearTimeout(timer);
  }
}

export async function researchGroundedTopic(
  topic: string,
  userPrompt?: string
): Promise<{
  extracted: ExtractedSource;
  references: GroundedReference[];
}> {
  if (process.env.WEB_GROUNDING_ENABLED === "false") {
    throw new WebGroundingError("disabled", "Web grounding is disabled.");
  }
  let last:
    | { text: string; metadata: GroundingMetadata | undefined }
    | undefined;
  for (const strict of [false, true]) {
    last = await groundedCall(topic, userPrompt, strict);
    const grounded = groundedSourceFromMetadata(topic, last.text, last.metadata);
    if (
      grounded.extracted.pages.length > 0 &&
      validateReferences(grounded.references)
    ) {
      return grounded;
    }
  }
  throw new WebGroundingError(
    "insufficient_sources",
    "Could not find enough authoritative sources. Upload notes or a PDF instead."
  );
}
