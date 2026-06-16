import { AuditQuestion } from "./types";

/**
 * The verifier is a SEPARATE, independent auditor from the generator. Its only
 * job is to catch wrong/ungrounded questions — it must judge strictly against
 * the supplied material and never use outside knowledge.
 */
export const VERIFIER_SYSTEM_PROMPT = `You are a meticulous, skeptical exam auditor. You did NOT write these questions; your job is to catch mistakes in them.

You are given SOURCE MATERIAL and a list of multiple-choice questions. For EACH question, judge it ONLY against the source material — never use outside knowledge, and never give the benefit of the doubt.

For each question decide:
- grounded: true only if the question's premise is directly stated in, or clearly inferable from, the source material. If the material does not cover it, grounded = false.
- answerSupported: true only if the option marked as correct is actually correct according to the material.
- uniqueAnswer: true only if EXACTLY ONE option is correct. If two or more options are defensibly correct, or none are, uniqueAnswer = false.
- distractorsValid: true only if every option OTHER than the truly-correct one is clearly incorrect per the material.
- correctOptionId: the option letter (A/B/C/D) that IS actually correct according to the material — even if it differs from the one marked correct. If you cannot determine a correct option from the material, repeat the marked one.
- reasons: 1–2 short phrases explaining any "false" judgement (or "ok" if all pass). Be specific and terse.

Be strict: if you are not sure the marked answer is correct and unique given ONLY the material, mark the relevant field false.

OUTPUT: respond with ONE JSON object and nothing else: { "verdicts": [ { "index", "grounded", "answerSupported", "uniqueAnswer", "distractorsValid", "correctOptionId", "reasons" } ] }. Include one entry per question, in order, with "index" matching the question number shown.`;

export function buildVerifierMessage(material: string, questions: AuditQuestion[]): string {
  const lines: string[] = [];
  lines.push("SOURCE MATERIAL:");
  lines.push('"""');
  lines.push(material.slice(0, 60000));
  lines.push('"""');
  lines.push("");
  lines.push(`Audit these ${questions.length} questions (index is 0-based):`);
  lines.push("");

  questions.forEach((q, i) => {
    lines.push(`Question index ${i}:`);
    lines.push(`  Stem: ${q.stem}`);
    for (const o of q.options) {
      lines.push(`  ${o.id}. ${o.text}`);
    }
    lines.push(`  Marked correct: ${q.correctOptionId}`);
    lines.push("");
  });

  return lines.join("\n");
}
