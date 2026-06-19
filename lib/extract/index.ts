import "./polyfills";
import pdfParseModule from "pdf-parse";

const pdfParse =
  (pdfParseModule as unknown as { default: typeof pdfParseModule }).default ??
  pdfParseModule;

export type ExtractedPage = {
  pageNumber: number | null;
  section?: string;
  text: string;
};

export type ExtractedSource = {
  title?: string;
  pages: ExtractedPage[];
  fullText: string;
  metadata?: Record<string, unknown>;
};

type PdfTextItem = {
  str?: string;
  transform?: number[];
};

type PdfPageData = {
  getTextContent(options: {
    normalizeWhitespace: boolean;
    disableCombineTextItems: boolean;
  }): Promise<{ items: PdfTextItem[] }>;
};

function normalizeDisplayText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function renderPdfPage(pageData: PdfPageData): Promise<string> {
  const content = await pageData.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  });
  let lastY: number | undefined;
  let text = "";
  for (const item of content.items) {
    const value = item.str ?? "";
    const y = item.transform?.[5];
    if (text && y !== undefined && lastY !== undefined && y !== lastY) {
      text += "\n";
    } else if (text && !text.endsWith("\n")) {
      text += " ";
    }
    text += value;
    lastY = y;
  }
  return normalizeDisplayText(text);
}

function looksLikeHeading(line: string, nextLine: string | undefined): boolean {
  const trimmed = line.trim();
  if (/^#{1,6}\s+\S/.test(trimmed)) return true;
  if (trimmed.length < 3 || trimmed.length > 90) return false;
  if (/^[A-Z][A-Z0-9\s:&/-]+$/.test(trimmed)) return true;
  if (trimmed.endsWith(":") && trimmed.split(/\s+/).length <= 10) return true;
  return Boolean(nextLine === "" && trimmed.split(/\s+/).length <= 8);
}

function extractNoteSections(content: string): ExtractedPage[] {
  const lines = content.replace(/\r/g, "").split("\n");
  const sections: ExtractedPage[] = [];
  let heading: string | undefined;
  let body: string[] = [];

  const flush = () => {
    const text = normalizeDisplayText(body.join("\n"));
    if (text) sections.push({ pageNumber: null, section: heading, text });
    body = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trimEnd();
    if (looksLikeHeading(line, lines[i + 1]?.trim())) {
      flush();
      heading = line.replace(/^#{1,6}\s+/, "").replace(/:$/, "").trim();
    } else {
      body.push(line);
    }
  }
  flush();

  if (sections.length === 0) {
    const text = normalizeDisplayText(content);
    return text ? [{ pageNumber: null, text }] : [];
  }
  return sections;
}

export async function extractSource(
  source:
    | { type: "text"; content: string; title?: string }
    | { type: "pdf"; buffer: Buffer; title?: string }
): Promise<ExtractedSource> {
  if (source.type === "text") {
    const pages = extractNoteSections(source.content);
    return {
      title: source.title,
      pages,
      fullText: pages.map((page) => page.text).join("\n\n"),
      metadata: { sectionCount: pages.length },
    };
  }

  const pageTexts: string[] = [];
  try {
    const data = await pdfParse(source.buffer, {
      pagerender: async (pageData: unknown) => {
        const text = await renderPdfPage(pageData as PdfPageData);
        pageTexts.push(text);
        return text;
      },
    });
    const pages = pageTexts
      .map((text, index) => ({
        pageNumber: index + 1,
        text: normalizeDisplayText(text),
      }))
      .filter((page) => page.text.length > 0);
    const fallbackText = normalizeDisplayText(data.text);
    const effectivePages =
      pages.length > 0
        ? pages
        : fallbackText
          ? [{ pageNumber: null, text: fallbackText }]
          : [];
    const info =
      data.info && typeof data.info === "object"
        ? (data.info as Record<string, unknown>)
        : {};
    const title =
      source.title ||
      (typeof info.Title === "string" && info.Title.trim()
        ? info.Title.trim()
        : undefined);
    return {
      title,
      pages: effectivePages,
      fullText: effectivePages.map((page) => page.text).join("\n\n"),
      metadata: {
        pageCount: data.numpages,
        renderedPageCount: pages.length,
        pageAware: pages.length > 0,
      },
    };
  } catch (error) {
    const data = await pdfParse(source.buffer);
    const text = normalizeDisplayText(data.text);
    return {
      title: source.title,
      pages: text ? [{ pageNumber: null, text }] : [],
      fullText: text,
      metadata: {
        pageCount: data.numpages,
        renderedPageCount: 0,
        pageAware: false,
        pageExtractionError:
          error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Backward-compatible helper for the legacy pipeline. */
export async function extractText(
  source: { type: "text"; content: string } | { type: "pdf"; buffer: Buffer }
): Promise<string> {
  return (await extractSource(source)).fullText;
}
