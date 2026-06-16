import "./polyfills";
// @ts-expect-error - CJS module
import pdfParse from "pdf-parse";

export async function extractText(
  source: { type: "text"; content: string } | { type: "pdf"; buffer: Buffer }
): Promise<string> {
  if (source.type === "text") return source.content.trim();

  const data = await pdfParse(source.buffer);
  return data.text.trim();
}
