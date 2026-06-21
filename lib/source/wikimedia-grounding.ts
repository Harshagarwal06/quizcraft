import type { ExtractedSource } from "@/lib/extract";
import type { GroundedReference } from "./store";

const TIMEOUT_MS = 7_000;
const MIN_EXTRACT_CHARS = 160;
const MIN_TOTAL_CHARS = 500;
const PROJECTS = [
  { domain: "en.wikipedia.org", label: "Wikipedia" },
  { domain: "simple.wikipedia.org", label: "Simple Wikipedia" },
  { domain: "en.wikibooks.org", label: "Wikibooks" },
  { domain: "en.wikiversity.org", label: "Wikiversity" },
] as const;

type WikimediaSearchPage = {
  key?: string;
  title?: string;
};

type WikimediaSearchResponse = {
  pages?: WikimediaSearchPage[];
};

type WikimediaSummary = {
  type?: string;
  title?: string;
  extract?: string;
  content_urls?: {
    desktop?: {
      page?: string;
    };
  };
};

function cleanExtract(value: string | undefined): string {
  return (value ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchProjectPages(
  project: (typeof PROJECTS)[number],
  topic: string,
  fetchImpl: typeof fetch
): Promise<
  {
    title: string;
    url: string;
    domain: string;
    label: string;
    text: string;
  }[]
> {
  const params = new URLSearchParams({
    q: topic,
    limit: "3",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = {
    "User-Agent": "QuizCraft/0.1 (evidence-backed educational quiz generator)",
  };
  try {
    const response = await fetchImpl(
      `https://${project.domain}/w/rest.php/v1/search/page?${params}`,
      {
        headers,
        signal: controller.signal,
      }
    );
    if (!response.ok) {
      throw new Error(`${project.label} returned ${response.status}.`);
    }
    const data = (await response.json()) as WikimediaSearchResponse;
    const summaries = await Promise.allSettled(
      (data.pages ?? [])
        .filter((page) => Boolean(page.key || page.title))
        .slice(0, 2)
        .map(async (page) => {
          const key = page.key || page.title || "";
          const summaryResponse = await fetchImpl(
            `https://${project.domain}/api/rest_v1/page/summary/${encodeURIComponent(
              key
            )}`,
            { headers, signal: controller.signal }
          );
          if (!summaryResponse.ok) {
            throw new Error(
              `${project.label} summary returned ${summaryResponse.status}.`
            );
          }
          return (await summaryResponse.json()) as WikimediaSummary;
        })
    );
    return summaries
      .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
      .filter(
        (summary) =>
          summary.type !== "disambiguation" && Boolean(summary.title)
      )
      .map((summary) => {
        const text = cleanExtract(summary.extract);
        const title = summary.title?.trim() ?? "";
        const fallbackUrl = `https://${project.domain}/wiki/${encodeURIComponent(
          title.replace(/ /g, "_")
        )}`;
        return {
          title,
          url: summary.content_urls?.desktop?.page || fallbackUrl,
          domain: project.domain,
          label: project.label,
          text,
        };
      })
      .filter((page) => page.text.length >= MIN_EXTRACT_CHARS);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Key-free grounded research fallback. It uses only retrieved reference text;
 * downstream question generation and verification remain evidence-only.
 */
export async function researchWikimediaTopic(
  topic: string,
  fetchImpl: typeof fetch = fetch
): Promise<{
  extracted: ExtractedSource;
  references: GroundedReference[];
}> {
  const settled = await Promise.allSettled(
    PROJECTS.map((project) => fetchProjectPages(project, topic, fetchImpl))
  );
  const projectPages = settled.map((result) =>
    result.status === "fulfilled" ? result.value : []
  );
  const pages = [
    ...projectPages.flatMap((results) => results.slice(0, 1)),
    ...projectPages.flatMap((results) => results.slice(1)),
  ]
    .filter(
      (page, index, all) =>
        all.findIndex((candidate) => candidate.url === page.url) === index
    )
    .slice(0, 4);
  const totalChars = pages.reduce((sum, page) => sum + page.text.length, 0);
  if (pages.length < 2 || totalChars < MIN_TOTAL_CHARS) {
    throw new Error(
      "Wikimedia fallback could not find two substantial reference pages for this topic."
    );
  }

  const references: GroundedReference[] = pages.map((page) => ({
    title: `${page.title} — ${page.label}`,
    url: page.url,
    domain: page.domain,
    authority: "established",
    supportedTexts: [page.text],
  }));
  return {
    extracted: {
      title: topic,
      pages: pages.map((page) => ({
        pageNumber: null,
        section: `${page.label}: ${page.title}`,
        text: page.text,
      })),
      fullText: pages.map((page) => page.text).join("\n\n"),
      metadata: {
        grounded: true,
        groundingProvider: "wikimedia",
        sourceDomains: [...new Set(pages.map((page) => page.domain))],
        supportedPassageCount: pages.length,
      },
    },
    references,
  };
}
