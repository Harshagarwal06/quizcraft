import "./polyfills";
import pdfParseModule from "pdf-parse";
// pdf-parse ships CommonJS; the ESM import gives us the module object,
// and the actual callable may be on .default depending on the bundler.
const pdfParse = (pdfParseModule as unknown as { default: typeof pdfParseModule }).default ?? pdfParseModule;

export async function extractText(
  source: { type: "text"; content: string } | { type: "pdf"; buffer: Buffer }
): Promise<string> {
  if (source.type === "text") return source.content.trim();

  const data = await pdfParse(source.buffer);
  return data.text.trim();
}
