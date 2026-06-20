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
  providerVerificationResultSchema,
  VERDICT_RESPONSE_SCHEMA,
} from "./types";

const VERIFY_TIMEOUT_MS = 35_000;
const TOKENS_PER_VERDICT = 220;
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

export function selectVerifier(): VerifierInfo | null {
  const genNorm = normalize(process.env.LLM_PROVIDER) ?? "hf";
  const opposite: VerifierProvider = genNorm === "hf" ? "gemini" : "hf";
  const hasHF = Boolean(process.env.HF_API_KEY);
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const preferences: VerifierProvider[] = [];
  const explicit = normalize(process.env.VERIFIER_PROVIDER);
  if (explicit) preferences.push(explicit);
  preferences.push(opposite, genNorm);

  for (const provider of preferences) {
    if (provider === "hf" && hasHF) {
      return { provider: "hf", model: HF_MODEL_NAME };
    }
    if (provider === "gemini" && hasGemini) {
      return { provider: "gemini", model: geminiModelName() };
    }
  }
  return null;
}

export function selectAlternateVerifier(
  current: VerifierInfo
): VerifierInfo | null {
  if (current.provider !== "hf" && process.env.HF_API_KEY) {
    return { provider: "hf", model: HF_MODEL_NAME };
  }
  if (current.provider !== "gemini" && process.env.GEMINI_API_KEY) {
    return { provider: "gemini", model: geminiModelName() };
  }
  return null;
}

async function requestVerdicts(
  material: string,
  questions: AuditQuestion[],
  info: VerifierInfo,
  timeoutMs: number
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
    const text = await callHFChat({
      system: VERIFIER_SYSTEM_PROMPT,
      user,
      maxTokens,
      timeoutMs,
    });
    raw = extractJsonLoose(text);
  }
  const parsed = providerVerificationResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Verifier schema validation failed: ${parsed.error.message}`);
  }
  return parsed.data.verdicts;
}

export function reconcileVerdicts(
  verdicts: QuestionVerdict[],
  expectedCount: number
): {
  valid: Map<number, QuestionVerdict>;
  affected: number[];
} {
  const valid = new Map<number, QuestionVerdict>();
  const duplicates = new Set<number>();
  for (const verdict of verdicts) {
    if (
      !Number.isInteger(verdict.index) ||
      verdict.index < 0 ||
      verdict.index >= expectedCount
    ) {
      continue;
    }
    if (valid.has(verdict.index)) {
      duplicates.add(verdict.index);
      valid.delete(verdict.index);
    } else if (!duplicates.has(verdict.index)) {
      valid.set(verdict.index, verdict);
    }
  }
  const affected = Array.from({ length: expectedCount }, (_, index) => index).filter(
    (index) => !valid.has(index)
  );
  return { valid, affected };
}

function incompleteVerdict(
  question: AuditQuestion,
  index: number
): QuestionVerdict {
  return {
    index,
    grounded: false,
    answerSupported: false,
    uniqueAnswer: false,
    distractorsValid: false,
    evidenceValid: false,
    correctOptionId: question.correctOptionId,
    reasons: ["verifier did not return one unique verdict after retry"],
    complete: false,
  };
}

/**
 * Fail-closed audit. Missing or duplicate indexes are retried once in a smaller
 * request. Any slot still unresolved becomes an explicit incomplete verdict,
 * which downstream code marks unverified rather than passing.
 */
export async function verifyQuestions(
  material: string,
  questions: AuditQuestion[],
  info: VerifierInfo,
  timeoutMs: number = VERIFY_TIMEOUT_MS
): Promise<QuestionVerdict[]> {
  let firstVerdicts: QuestionVerdict[];
  let fullRequestRetried = false;
  try {
    firstVerdicts = await requestVerdicts(material, questions, info, timeoutMs);
  } catch (error) {
    const retryableFormatError =
      error instanceof SyntaxError ||
      (error instanceof Error &&
        (error.message.startsWith("Verifier schema validation failed") ||
          error.message.startsWith("Failed to parse JSON from model output")));
    if (!retryableFormatError) {
      console.warn("[verify] verifier request failed closed:", error);
      return questions.map(incompleteVerdict);
    }
    console.warn("[verify] initial verdict request failed; retrying once:", error);
    fullRequestRetried = true;
    try {
      firstVerdicts = await requestVerdicts(
        material,
        questions,
        info,
        Math.min(timeoutMs, 20_000)
      );
    } catch (retryError) {
      console.warn("[verify] full verdict retry failed:", retryError);
      return questions.map(incompleteVerdict);
    }
  }
  const first = reconcileVerdicts(firstVerdicts, questions.length);
  const results = new Map(first.valid);

  if (first.affected.length > 0 && !fullRequestRetried) {
    const retryQuestions = first.affected.map((index) => questions[index]);
    try {
      const retry = reconcileVerdicts(
        await requestVerdicts(
          material,
          retryQuestions,
          info,
          Math.min(timeoutMs, 20_000)
        ),
        retryQuestions.length
      );
      for (const [localIndex, verdict] of retry.valid) {
        const originalIndex = first.affected[localIndex];
        results.set(originalIndex, { ...verdict, index: originalIndex });
      }
    } catch (error) {
      console.warn("[verify] focused verdict retry failed:", error);
    }
  }

  return questions.map(
    (question, index) =>
      results.get(index) ?? incompleteVerdict(question, index)
  );
}

/**
 * Keep verification fail-closed while tolerating a provider outage or exhausted
 * quota. Only slots that the primary provider left incomplete are retried with
 * the other configured provider.
 */
export async function verifyQuestionsWithFallback(
  material: string,
  questions: AuditQuestion[],
  info: VerifierInfo,
  timeoutMs: number = VERIFY_TIMEOUT_MS
): Promise<{ verdicts: QuestionVerdict[]; verifierModel: string }> {
  const primary = await verifyQuestions(material, questions, info, timeoutMs);
  const incompleteIndexes = primary
    .map((verdict, index) => (verdict.complete === false ? index : -1))
    .filter((index) => index >= 0);
  const alternate = selectAlternateVerifier(info);
  if (incompleteIndexes.length === 0 || !alternate) {
    return { verdicts: primary, verifierModel: info.model };
  }

  console.warn(
    `[verify] ${info.provider} left ${incompleteIndexes.length} incomplete verdict(s); trying ${alternate.provider}`
  );
  const fallback = await verifyQuestions(
    material,
    incompleteIndexes.map((index) => questions[index]),
    alternate,
    Math.min(timeoutMs, 30_000)
  );
  let usedFallback = false;
  const verdicts = primary.slice();
  fallback.forEach((verdict, localIndex) => {
    if (verdict.complete === false) return;
    const originalIndex = incompleteIndexes[localIndex];
    verdicts[originalIndex] = { ...verdict, index: originalIndex };
    usedFallback = true;
  });
  return {
    verdicts,
    verifierModel: usedFallback
      ? incompleteIndexes.length === questions.length
        ? alternate.model
        : `${info.model} + ${alternate.model}`
      : info.model,
  };
}
