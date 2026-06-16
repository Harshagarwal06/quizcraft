import { z } from "zod";

// HF/Qwen does not honor a strict output schema (unlike Gemini structured
// output), so coerce the loose shapes it tends to emit.
const lenientBool = z.preprocess((v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["true", "yes", "1"].includes(v.trim().toLowerCase());
  if (typeof v === "number") return v !== 0;
  return v;
}, z.boolean());

const lenientReasons = z.preprocess((v) => {
  if (v == null) return [];
  if (typeof v === "string") return v.trim() ? [v] : [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [String(v)];
}, z.array(z.string()));

const lenientOptionId = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
  z.enum(["A", "B", "C", "D"])
);

/**
 * Per-question audit result from the verifier. The verifier judges each question
 * ONLY against the supplied source material.
 */
export const questionVerdictSchema = z.object({
  index: z.coerce.number().int(), // 0-based position in the audited list
  grounded: lenientBool, // is the stem's premise supported by the material?
  answerSupported: lenientBool, // is the marked-correct option actually correct?
  uniqueAnswer: lenientBool, // is exactly one option correct (no multiple/none)?
  distractorsValid: lenientBool, // are all three distractors actually incorrect?
  correctOptionId: lenientOptionId, // which option the verifier believes is correct
  reasons: lenientReasons, // short justifications / failure notes
});

export const verificationResultSchema = z.object({
  verdicts: z.array(questionVerdictSchema),
});

export type QuestionVerdict = z.infer<typeof questionVerdictSchema>;
export type VerificationResult = z.infer<typeof verificationResultSchema>;

/** Gemini structured-output schema (OpenAPI subset) mirroring the Zod above. */
export const VERDICT_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          grounded: { type: "boolean" },
          answerSupported: { type: "boolean" },
          uniqueAnswer: { type: "boolean" },
          distractorsValid: { type: "boolean" },
          correctOptionId: { type: "string", enum: ["A", "B", "C", "D"] },
          reasons: { type: "array", items: { type: "string" } },
        },
        required: [
          "index",
          "grounded",
          "answerSupported",
          "uniqueAnswer",
          "distractorsValid",
          "correctOptionId",
          "reasons",
        ],
      },
    },
  },
  required: ["verdicts"],
};

/** A question shaped for auditing (subset of the persisted/ generated question). */
export interface AuditQuestion {
  stem: string;
  options: { id: "A" | "B" | "C" | "D"; text: string }[];
  correctOptionId: "A" | "B" | "C" | "D";
}
