// Topic-expansion stage. Given a short topic (or thin notes), asks Google Gemini
// to produce a comprehensive, factual study briefing that becomes the grounding
// material for the downstream quiz generator. Best-effort: any failure returns
// null so the caller falls back to the raw input.

import {
  fetchGeminiWithFallback,
  hasGeminiApiKeys,
} from "@/lib/llm/gemini-keys";

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
// Cap the call so the second-stage generation still fits the route's maxDuration
// (60s). Expansion + generation run sequentially, so keep this tight.
const TIMEOUT_MS = 12_000;

/**
 * Instruction for Gemini. The briefing it returns is the ONLY source the exam
 * writer sees, so it must be dense with concrete, testable, accurate facts.
 */
export const EXPANSION_PROMPT = `You are a subject-matter expert writing a comprehensive study briefing on a topic. This briefing will be the ONLY source material used to write an exam, so it must be dense with concrete, testable, factually accurate information.

Cover the topic thoroughly and in a well-organized way, including:
- A short overview that frames the topic.
- Key concepts and precise definitions.
- Important facts, figures, dates, names, and quantities.
- Core processes, mechanisms, or cause-and-effect relationships.
- Relationships, comparisons, and distinctions between related ideas.
- Notable examples or real-world applications.
- Common misconceptions and the correct understanding.

RULES:
- State only well-established facts. Do NOT speculate, invent figures, or pad with filler.
- If the topic is broad, prioritize the most exam-relevant, widely-taught material.
- Plain text only: no markdown, code fences, bullets characters, emojis, or LaTeX. Use short labeled sections and ordinary sentences.
- Aim for roughly 500-900 words of dense, substantive content (no filler).`;

function buildRequest(seed: string, userPrompt?: string): string {
  const lines: string[] = [];
  lines.push(`Topic / material to expand into a study briefing:`);
  lines.push(`"""`);
  lines.push(seed.slice(0, 8000));
  lines.push(`"""`);
  if (userPrompt) {
    lines.push("");
    lines.push(`Bias the coverage toward this focus from the learner: ${userPrompt}`);
  }
  return lines.join("\n");
}

/**
 * Expands a topic/thin material into a detailed study briefing via Gemini.
 * Returns the briefing text, or null if no API key is set or the call fails.
 */
export async function expandTopic(seed: string, userPrompt?: string): Promise<string | null> {
  if (!hasGeminiApiKeys()) return null;

  try {
    const response = await fetchGeminiWithFallback({
      endpoint: `${ENDPOINT}/${GEMINI_MODEL}:generateContent`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: EXPANSION_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: buildRequest(seed, userPrompt) }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 2048,
            // Disable "thinking" (on by default for Gemini 2.5): a factual briefing
            // needs no reasoning tokens, and it keeps the call fast + within budget.
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      },
      timeoutMs: TIMEOUT_MS,
      label: "Gemini topic expansion",
    });

    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim();

    if (!text) {
      console.warn("[expand] Gemini returned no text content");
      return null;
    }
    return text;
  } catch (err) {
    console.warn("[expand] topic expansion failed:", err);
    return null;
  }
}
