import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

type PdfParseResult = { text: string };
type PdfParseFn = (buf: Buffer) => Promise<PdfParseResult>;

export async function extractText(
  source: { type: "text"; content: string } | { type: "pdf"; buffer: Buffer }
): Promise<string> {
  if (source.type === "text") return source.content.trim();

  const pdfParse = _require("pdf-parse") as PdfParseFn;
  const data = await pdfParse(source.buffer);
  return data.text.trim();
}
