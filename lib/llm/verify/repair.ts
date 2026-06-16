import { GeneratedQuestion } from "../types";
import { getGenerator } from "../index";
import { shuffleQuizOptions } from "../shuffle";
import { verifyQuestions, VerifierInfo } from "./index";
import { AuditQuestion, QuestionVerdict } from "./types";

// A regeneration round (generate replacements + re-verify them) needs roughly
// this much wall-clock time; skip it if the invocation budget is nearly spent.
const REGEN_MIN_REMAINING_MS = 28_000;

export type Verdict = "pass" | "repaired" | "flagged";

export interface VerificationDetail {
  grounded: boolean;
  answerSupported: boolean;
  uniqueAnswer: boolean;
  distractorsValid: boolean;
  reasons: string[];
  initialVerdict: "pass" | "fail";
  suggestedCorrectOptionId?: "A" | "B" | "C" | "D";
}

export interface RepairedQuestion {
  question: GeneratedQuestion; // possibly key-fixed or fully replaced
  verdict: Verdict;
  detail: VerificationDetail;
}

export interface RepairResult {
  questions: RepairedQuestion[];
  summary: {
    total: number;
    passedInitial: number;
    failedInitial: number;
    repaired: number;
    flagged: number;
  };
}

const toAudit = (q: GeneratedQuestion): AuditQuestion => ({
  stem: q.stem,
  options: q.options,
  correctOptionId: q.correctOptionId,
});

const isPass = (v: QuestionVerdict): boolean =>
  v.grounded && v.answerSupported && v.uniqueAnswer && v.distractorsValid;

// A wrong answer KEY (but otherwise sound question) is the cheapest fix: the
// stem is grounded, exactly one option is correct, the distractors are wrong —
// only the marked letter is off. Just relabel the correct option.
const isKeyFixable = (q: GeneratedQuestion, v: QuestionVerdict): boolean =>
  v.grounded &&
  v.uniqueAnswer &&
  v.distractorsValid &&
  !v.answerSupported &&
  v.correctOptionId !== q.correctOptionId &&
  q.options.some((o) => o.id === v.correctOptionId);

function detailFrom(
  v: QuestionVerdict,
  initialVerdict: "pass" | "fail"
): VerificationDetail {
  return {
    grounded: v.grounded,
    answerSupported: v.answerSupported,
    uniqueAnswer: v.uniqueAnswer,
    distractorsValid: v.distractorsValid,
    reasons: v.reasons,
    initialVerdict,
    suggestedCorrectOptionId: v.correctOptionId,
  };
}

/**
 * Audits every question, then runs ONE bounded repair round:
 *  - wrong key (otherwise sound)         → relabel correct option in place
 *  - ungrounded / ambiguous / bad distractor → regenerate a replacement, re-verify,
 *                                              swap in if it passes else flag
 * Never loops; if time is short the regeneration step is skipped and the bad
 * questions are flagged.
 */
export async function verifyAndRepair(opts: {
  material: string;
  questions: GeneratedQuestion[];
  verifier: VerifierInfo;
  deadline: number;
  userPrompt?: string;
  seed?: number;
}): Promise<RepairResult> {
  const { material, questions, verifier, deadline } = opts;

  const verdicts = await verifyQuestions(material, questions.map(toAudit), verifier);

  const results: RepairedQuestion[] = questions.map((q, i) => {
    const v = verdicts[i];
    const initiallyPassed = isPass(v);

    if (initiallyPassed) {
      return { question: q, verdict: "pass", detail: detailFrom(v, "pass") };
    }
    if (isKeyFixable(q, v)) {
      return {
        question: { ...q, correctOptionId: v.correctOptionId },
        verdict: "repaired",
        detail: detailFrom(v, "fail"),
      };
    }
    // Needs regeneration (placeholder verdict; resolved below).
    return { question: q, verdict: "flagged", detail: detailFrom(v, "fail") };
  });

  // Indices that still need a regenerated replacement.
  const needsRegen = results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.verdict === "flagged");

  if (needsRegen.length > 0 && Date.now() < deadline - REGEN_MIN_REMAINING_MS) {
    try {
      const focusTopics = needsRegen
        .map(({ i }) => questions[i].topic)
        .filter(Boolean)
        .join(", ");
      const generator = getGenerator();
      const replacementQuiz = shuffleQuizOptions(
        await generator.generate({
          sourceText: material,
          userPrompt: focusTopics
            ? `Focus on these topics from the material: ${focusTopics}.`
            : opts.userPrompt,
          questionCount: needsRegen.length,
          seed: (opts.seed ?? Math.floor(Math.random() * 1_000_000)) + 7,
        })
      );

      const replacements = replacementQuiz.questions;
      const repVerdicts = await verifyQuestions(
        material,
        replacements.map(toAudit),
        verifier
      );

      // Take each passing replacement to fill the next flagged slot.
      let rIdx = 0;
      for (const { i } of needsRegen) {
        while (rIdx < replacements.length && !isPass(repVerdicts[rIdx])) rIdx++;
        if (rIdx < replacements.length) {
          results[i] = {
            question: replacements[rIdx],
            verdict: "repaired",
            detail: detailFrom(repVerdicts[rIdx], "fail"),
          };
          rIdx++;
        }
        // else: leave as flagged
      }
    } catch (err) {
      // Regeneration is best-effort; flagged questions simply stay flagged.
      console.warn("[verify] repair regeneration failed:", err);
    }
  }

  const passedInitial = verdicts.filter(isPass).length;
  const summary = {
    total: questions.length,
    passedInitial,
    failedInitial: questions.length - passedInitial,
    repaired: results.filter((r) => r.verdict === "repaired").length,
    flagged: results.filter((r) => r.verdict === "flagged").length,
  };

  return { questions: results, summary };
}
