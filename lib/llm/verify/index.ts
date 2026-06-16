import {
  callHFChat,
  callGeminiJSON,
  extractJsonLoose,
  geminiModelName,
  HF_MODEL_NAME,
} from "../client";
import { VERIFIER_SYSTEM_PROMPT, buildVerifierMessage } from "./prompt";
import {
  AuditQuestion,
  QuestionVerdict,
  verificationResultSchema,
  VERDICT_RESPONSE_SCHEMA,
} from "./types";

const VERIFY_TIMEOUT_MS = 35_000;
const TOKENS_PER_VERDICT = 200;
const VERDICT_OVERHEAD = 400;
const MAX_OUTPUT_TOKENS = 8192;

function maxTokensFor(n: number): number {
  return Math.min(MAX_OUTPUT_TOKENS, VERDICT_OVERHEAD + n * TOKENS_PER_VERDICT);
}

export type VerifierProvider = "hf" | "gemini";

export interface VerifierInfo {
  provider: VerifierProvider;
  model: string;
}

function normalize(p?: string): VerifierProvider | undefined {
  if (p === "hf" || p === "huggingface") return "hf";
  if (p === "gemini" || p === "google") return "gemini";
  return undefined;
}

/**
 * Choose the verifier provider. Default is cross-model (the provider OPPOSITE the
 * generator) so the judge is independent of the author. Overridable via
 * VERIFIER_PROVIDER. Falls back to the only available key (incl. same-model
 * self-check) and returns null if no verifier key exists at all.
 */
export function selectVerifier(): VerifierInfo | null {
  const genNorm = normalize(process.env.LLM_PROVIDER) ?? "hf";
  const opposite: VerifierProvider = genNorm === "hf" ? "gemini" : "hf";
  const hasHF = !!process.env.HF_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;

  const prefs: VerifierProvider[] = [];
  const explicit = normalize(process.env.VERIFIER_PROVIDER);
  if (explicit) prefs.push(explicit);
  prefs.push(opposite, genNorm);

  for (const p of prefs) {
    if (p === "hf" && hasHF) return { provider: "hf", model: HF_MODEL_NAME };
    if (p === "gemini" && hasGemini) return { provider: "gemini", model: geminiModelName() };
  }
  return null;
}

/**
 * Audits `questions` against `material` with the chosen verifier. Always returns
 * exactly one verdict per question (aligned by index); if the model under-returns,
 * the missing slots get a lenient default so a question is never flagged merely
 * because the verifier forgot it.
 */
export async function verifyQuestions(
  material: string,
  questions: AuditQuestion[],
  info: VerifierInfo,
  timeoutMs: number = VERIFY_TIMEOUT_MS
): Promise<QuestionVerdict[]> {
  const user = buildVerifierMessage(material, questions);
  const maxTokens = maxTokensFor(questions.length);

  let raw: unknown;
  if (info.provider === "gemini") {
    const text = await callGeminiJSON({
      system: VERIFIER_SYSTEM_PROMPT,
      user,
      schema: VERDICT_RESPONSE_SCHEMA,
      maxTokens,
      timeoutMs,
      model: info.model,
    });
    raw = JSON.parse(text);
  } else {
    const text = await callHFChat({ system: VERIFIER_SYSTEM_PROMPT, user, maxTokens, timeoutMs });
    raw = extractJsonLoose(text);
  }

  const parsed = verificationResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Verifier schema validation failed: ${parsed.error.message}`);
  }

  const byIndex = new Map<number, QuestionVerdict>();
  parsed.data.verdicts.forEach((v, i) => {
    const idx =
      Number.isInteger(v.index) && v.index >= 0 && v.index < questions.length ? v.index : i;
    if (!byIndex.has(idx)) byIndex.set(idx, { ...v, index: idx });
  });

  return questions.map((q, i) => {
    const v = byIndex.get(i);
    if (v) return v;
    // Lenient default for an absent verdict — treated as a pass downstream.
    return {
      index: i,
      grounded: true,
      answerSupported: true,
      uniqueAnswer: true,
      distractorsValid: true,
      correctOptionId: q.correctOptionId,
      reasons: ["verifier returned no verdict for this question"],
    };
  });
}
