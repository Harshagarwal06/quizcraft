import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

import { generateWithFallback } from "../lib/llm";
import { SYSTEM_PROMPT } from "../lib/llm/prompt";
import { generatedQuestionSchema, generatedQuizSchema, type GeneratedQuestion } from "../lib/llm/types";
import { shuffleQuizOptions } from "../lib/llm/shuffle";
import { selectVerifier, verifyQuestions, type VerifierInfo } from "../lib/llm/verify";
import { VERIFIER_SYSTEM_PROMPT } from "../lib/llm/verify/prompt";
import { questionVerdictSchema, type QuestionVerdict } from "../lib/llm/verify/types";
import { verifyAndRepair, type Verdict } from "../lib/llm/verify/repair";
import { HF_MODEL_NAME, geminiModelName } from "../lib/llm/client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportsDir = path.join(root, "eval", "reports");

loadEnv({ path: path.join(root, ".env.local"), quiet: true });
loadEnv({ path: path.join(root, ".env"), override: false, quiet: true });

// Enable bounded Gemini rate-limit backoff for the eval (free tier is ~5 RPM).
// Scoped to the harness so the app's time-budgeted routes are unaffected.
process.env.EVAL_GEMINI_BACKOFF = "1";

const optionIdSchema = z.enum(["A", "B", "C", "D"]);
const expectedVerdictSchema = z.object({
  grounded: z.boolean(),
  answerSupported: z.boolean(),
  uniqueAnswer: z.boolean(),
  distractorsValid: z.boolean(),
  correctOptionId: optionIdSchema,
});

const evalSourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  domain: z.string().min(1),
  split: z.enum(["benchmark", "heldout"]),
  questionCount: z.number().int().positive(),
  seed: z.number().int(),
  sourceText: z.string().min(100),
});

const phase2SourcesSchema = z.object({
  version: z.number().int(),
  sources: z.array(evalSourceSchema).min(1),
});

const auditQuestionSchema = z.object({
  stem: z.string().min(1),
  options: z
    .array(z.object({ id: optionIdSchema, text: z.string().min(1) }))
    .length(4),
  correctOptionId: optionIdSchema,
});

const calibrationCaseSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  expected: expectedVerdictSchema,
  question: auditQuestionSchema,
});

const calibrationDatasetSchema = z.object({
  version: z.number().int(),
  cases: z.array(calibrationCaseSchema).min(50),
});

const benchmarkFixtureSchema = z.object({
  sourceId: z.string().min(1),
  generatorProvider: z.string().min(1),
  generatorModel: z.string().min(1),
  verifierModel: z.string().min(1),
  quiz: generatedQuizSchema,
  baselineVerdicts: z.array(questionVerdictSchema),
  replacementQuestions: z.array(generatedQuestionSchema),
  replacementVerdicts: z.array(questionVerdictSchema),
});

const benchmarkFixturesSchema = z.object({
  version: z.number().int(),
  quizzes: z.array(benchmarkFixtureSchema).min(1),
});

type EvalSource = z.infer<typeof evalSourceSchema>;
type CalibrationCase = z.infer<typeof calibrationCaseSchema>;
type BenchmarkFixture = z.infer<typeof benchmarkFixtureSchema>;
type ExpectedVerdict = z.infer<typeof expectedVerdictSchema>;

interface EvalRunConfig {
  live: boolean;
  // True for offline fixture runs: the numbers are synthetic harness validation,
  // NOT measurements, and must never be cited as results.
  synthetic: boolean;
  generatedAt: string;
  generatorProvider: string;
  // The model the app's repair loop uses (drives repairs).
  repairVerifierProvider: string;
  repairVerifierModel: string;
  // The independent judge whose numbers we report and calibrate against humans.
  evalJudgeProvider: string;
  evalJudgeModel: string;
  // True when the eval judge is a different provider than the repair verifier, so
  // the post-repair re-judge is genuinely independent of the repair decision.
  postRepairIndependent: boolean;
  promptHashes: {
    generator: string;
    verifier: string;
  };
}

interface EvalCaseResult {
  id: string;
  sourceId: string;
  expectedError: boolean;
  predictedError: boolean;
  expected: ExpectedVerdict;
  predicted: QuestionVerdict;
}

interface RateMetric {
  count: number;
  total: number;
  rate: number;
  wilson95: {
    low: number;
    high: number;
  };
}

interface EvalReport {
  version: 1;
  config: EvalRunConfig;
  calibration: {
    caseCount: number;
    status: "pass" | "warning" | "failed";
    accuracy: number;
    precision: number;
    recall: number;
    f1: number;
    cohenKappa: number;
    dimensionAgreement: Record<keyof ExpectedVerdict, number>;
    confusion: {
      tp: number;
      fp: number;
      tn: number;
      fn: number;
    };
    cases: EvalCaseResult[];
  };
  benchmark: {
    sourceCount: number;
    questionCount: number;
    schemaValidity: RateMetric;
    groundingRate: RateMetric;
    answerKeyCorrectnessRate: RateMetric;
    uniqueAnswerRate: RateMetric;
    distractorValidityRate: RateMetric;
    baselineErrorRate: RateMetric;
    postRepairShippedErrorRate: RateMetric;
    repairRate: RateMetric;
    removalRate: RateMetric;
    difficultyDistribution: Record<"easy" | "medium" | "hard", number>;
    sources: BenchmarkSourceResult[];
  };
}

interface BenchmarkSourceResult {
  sourceId: string;
  split: EvalSource["split"];
  domain: string;
  title: string;
  baseline: {
    total: number;
    errors: number;
  };
  postRepair: {
    shipped: number;
    errors: number;
    repaired: number;
    flagged: number;
  };
}

interface RepairedOfflineQuestion {
  question: GeneratedQuestion;
  verdict: Verdict;
  baselineIndex: number;
  postVerdict: QuestionVerdict | null;
}

// These IDs are cases where the offline fixture judge is expected to disagree
// with the human label. Live mode calls the real verifier instead, so it won't use this.
const calibrationFixtureDisagreements = new Map<string, Partial<ExpectedVerdict>>([
  ["cal-cell-006", { distractorsValid: true }],
  ["cal-glucose-008", { distractorsValid: true }],
  ["cal-triage-008", { distractorsValid: true }],
  ["cal-http-004", { uniqueAnswer: true, distractorsValid: true }],
]);

function normalizeProvider(p?: string): "hf" | "gemini" | undefined {
  if (p === "hf" || p === "huggingface") return "hf";
  if (p === "gemini" || p === "google") return "gemini";
  return undefined;
}

function judgeFor(provider: "hf" | "gemini"): VerifierInfo | null {
  if (provider === "hf") {
    return process.env.HF_API_KEY ? { provider: "hf", model: HF_MODEL_NAME } : null;
  }
  return process.env.GEMINI_API_KEY ? { provider: "gemini", model: geminiModelName() } : null;
}

/**
 * The eval judge is the model whose numbers we report and calibrate against the
 * human labels — kept SEPARATE from the app's repair verifier. Default: the
 * cross-model provider (opposite the generator), i.e. independent of generation,
 * which gives a credible baseline error rate. Override with EVAL_JUDGE_PROVIDER
 * (e.g. set it to the provider the repair loop does NOT use, to make the
 * post-repair re-judge independent of the repair decision too).
 *
 * Two-provider limitation: with only HF + Gemini, a single judge can be
 * independent of generation OR of repair, not both — see the methodology doc.
 */
function selectEvalJudge(): VerifierInfo {
  const explicit = normalizeProvider(process.env.EVAL_JUDGE_PROVIDER);
  if (explicit) {
    const judge = judgeFor(explicit);
    if (!judge) throw new Error(`EVAL_JUDGE_PROVIDER=${explicit} but its API key is not set`);
    return judge;
  }
  const generator = normalizeProvider(process.env.LLM_PROVIDER) ?? "hf";
  const opposite = generator === "hf" ? "gemini" : "hf";
  const judge = judgeFor(opposite) ?? judgeFor(generator);
  if (!judge) throw new Error("No eval judge available: set HF_API_KEY or GEMINI_API_KEY");
  return judge;
}

function isPassingVerdict(v: Pick<QuestionVerdict, "grounded" | "answerSupported" | "uniqueAnswer" | "distractorsValid">): boolean {
  return v.grounded && v.answerSupported && v.uniqueAnswer && v.distractorsValid;
}

function isKeyFixable(q: GeneratedQuestion, v: QuestionVerdict): boolean {
  return (
    v.grounded &&
    v.uniqueAnswer &&
    v.distractorsValid &&
    !v.answerSupported &&
    v.correctOptionId !== q.correctOptionId &&
    q.options.some((o) => o.id === v.correctOptionId)
  );
}

function toQuestionVerdict(expected: ExpectedVerdict, index: number, reasons: string[]): QuestionVerdict {
  return {
    index,
    grounded: expected.grounded,
    answerSupported: expected.answerSupported,
    uniqueAnswer: expected.uniqueAnswer,
    distractorsValid: expected.distractorsValid,
    correctOptionId: expected.correctOptionId,
    reasons,
  };
}

function fixtureCalibrationVerdict(c: CalibrationCase, index: number): QuestionVerdict {
  const override = calibrationFixtureDisagreements.get(c.id);
  const predicted = override ? { ...c.expected, ...override } : c.expected;
  return toQuestionVerdict(predicted, index, override ? ["fixture judge disagreement"] : ["ok"]);
}

function wilson(count: number, total: number): RateMetric {
  if (total === 0) {
    return { count, total, rate: 0, wilson95: { low: 0, high: 0 } };
  }
  const zScore = 1.96;
  const p = count / total;
  const denom = 1 + (zScore * zScore) / total;
  const center = (p + (zScore * zScore) / (2 * total)) / denom;
  const margin =
    (zScore * Math.sqrt((p * (1 - p)) / total + (zScore * zScore) / (4 * total * total))) /
    denom;
  return {
    count,
    total,
    rate: round4(p),
    wilson95: { low: round4(Math.max(0, center - margin)), high: round4(Math.min(1, center + margin)) },
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function percentage(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

async function readJson<T>(relativePath: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await readFile(path.join(root, relativePath), "utf8");
  return schema.parse(JSON.parse(raw));
}

function ensureUniqueIds(items: { id: string }[], label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`${label} contains duplicate id: ${item.id}`);
    seen.add(item.id);
  }
}

function assertDatasetIntegrity(sources: EvalSource[], calibrationCases: CalibrationCase[]): void {
  ensureUniqueIds(sources, "phase2 sources");
  ensureUniqueIds(calibrationCases, "calibration cases");
  const sourceIds = new Set(sources.map((s) => s.id));
  for (const c of calibrationCases) {
    if (!sourceIds.has(c.sourceId)) {
      throw new Error(`Calibration case ${c.id} points to unknown source ${c.sourceId}`);
    }
  }
}

function scoreCalibration(cases: CalibrationCase[], predicted: QuestionVerdict[]): EvalReport["calibration"] {
  if (cases.length !== predicted.length) {
    throw new Error(`Calibration result count mismatch: ${predicted.length} for ${cases.length} cases`);
  }

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  const dimensionHits: Record<keyof ExpectedVerdict, number> = {
    grounded: 0,
    answerSupported: 0,
    uniqueAnswer: 0,
    distractorsValid: 0,
    correctOptionId: 0,
  };

  const results: EvalCaseResult[] = cases.map((c, i) => {
    const p = predicted[i];
    const expectedError = !isPassingVerdict(c.expected);
    const predictedError = !isPassingVerdict(p);
    if (expectedError && predictedError) tp++;
    if (!expectedError && predictedError) fp++;
    if (!expectedError && !predictedError) tn++;
    if (expectedError && !predictedError) fn++;

    for (const key of Object.keys(dimensionHits) as (keyof ExpectedVerdict)[]) {
      if (c.expected[key] === p[key]) dimensionHits[key]++;
    }

    return {
      id: c.id,
      sourceId: c.sourceId,
      expectedError,
      predictedError,
      expected: c.expected,
      predicted: p,
    };
  });

  const total = cases.length;
  const accuracy = (tp + tn) / total;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const pObserved = accuracy;
  const expectedYes = ((tp + fp) / total) * ((tp + fn) / total);
  const expectedNo = ((tn + fn) / total) * ((tn + fp) / total);
  const pExpected = expectedYes + expectedNo;
  const cohenKappa = pExpected === 1 ? 1 : (pObserved - pExpected) / (1 - pExpected);
  const status = cohenKappa < 0.4 ? "failed" : cohenKappa < 0.6 ? "warning" : "pass";

  const dimensionAgreement = Object.fromEntries(
    (Object.keys(dimensionHits) as (keyof ExpectedVerdict)[]).map((key) => [
      key,
      round4(dimensionHits[key] / total),
    ])
  ) as Record<keyof ExpectedVerdict, number>;

  return {
    caseCount: total,
    status,
    accuracy: round4(accuracy),
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(f1),
    cohenKappa: round4(cohenKappa),
    dimensionAgreement,
    confusion: { tp, fp, tn, fn },
    cases: results,
  };
}

function applyOfflineRepair(fixture: BenchmarkFixture): RepairedOfflineQuestion[] {
  const results: RepairedOfflineQuestion[] = [];
  const replacements = fixture.replacementQuestions;
  const replacementVerdicts = fixture.replacementVerdicts;
  let replacementIndex = 0;

  fixture.quiz.questions.forEach((question, index) => {
    const baseline = fixture.baselineVerdicts[index];
    if (!baseline) throw new Error(`${fixture.sourceId} missing baseline verdict for question ${index}`);

    if (isPassingVerdict(baseline)) {
      results.push({ question, verdict: "pass", baselineIndex: index, postVerdict: baseline });
      return;
    }

    if (isKeyFixable(question, baseline)) {
      results.push({
        question: { ...question, correctOptionId: baseline.correctOptionId },
        verdict: "repaired",
        baselineIndex: index,
        postVerdict: {
          ...baseline,
          answerSupported: true,
          reasons: ["answer key relabeled by repair loop"],
        },
      });
      return;
    }

    // Find the next passing replacement. This assumes a FIFO pairing where
    // baseline bad question `i` claims the next available passing replacement.
    while (
      replacementIndex < replacements.length &&
      !isPassingVerdict(replacementVerdicts[replacementIndex])
    ) {
      replacementIndex++;
    }

    if (replacementIndex < replacements.length) {
      results.push({
        question: replacements[replacementIndex],
        verdict: "repaired",
        baselineIndex: index,
        postVerdict: replacementVerdicts[replacementIndex],
      });
      replacementIndex++;
      return;
    }

    results.push({ question, verdict: "flagged", baselineIndex: index, postVerdict: null });
  });

  return results;
}

function validateFixture(fixture: BenchmarkFixture): void {
  const parsed = generatedQuizSchema.safeParse(fixture.quiz);
  if (!parsed.success) throw new Error(`${fixture.sourceId} fixture quiz failed schema validation`);
  if (fixture.baselineVerdicts.length !== fixture.quiz.questions.length) {
    throw new Error(`${fixture.sourceId} baseline verdict count does not match question count`);
  }
  if (fixture.replacementQuestions.length !== fixture.replacementVerdicts.length) {
    throw new Error(`${fixture.sourceId} replacement verdict count does not match replacement question count`);
  }
}

function summarizeBenchmark(
  sources: EvalSource[],
  benchmarkInputs: {
    sourceId: string;
    generatorProvider: string;
    generatorModel: string;
    verifierModel: string;
    quiz: { title: string; questions: GeneratedQuestion[] };
    baselineVerdicts: QuestionVerdict[];
    repaired: RepairedOfflineQuestion[];
  }[]
): EvalReport["benchmark"] {
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  let schemaValid = 0;
  let questionCount = 0;
  let grounded = 0;
  let answerSupported = 0;
  let uniqueAnswer = 0;
  let distractorsValid = 0;
  let baselineErrors = 0;
  let shippedCount = 0;
  let shippedErrors = 0;
  let repairedCount = 0;
  let flaggedCount = 0;
  const difficultyCounts = { easy: 0, medium: 0, hard: 0 };
  const sourceResults: BenchmarkSourceResult[] = [];

  for (const input of benchmarkInputs) {
    const source = sourceById.get(input.sourceId);
    if (!source) throw new Error(`Benchmark fixture points to unknown source ${input.sourceId}`);

    const schemaOk = generatedQuizSchema.safeParse(input.quiz).success;
    if (schemaOk) schemaValid += input.quiz.questions.length;
    questionCount += input.quiz.questions.length;

    for (const q of input.quiz.questions) {
      difficultyCounts[q.difficulty]++;
    }

    for (const v of input.baselineVerdicts) {
      if (v.grounded) grounded++;
      if (v.answerSupported) answerSupported++;
      if (v.uniqueAnswer) uniqueAnswer++;
      if (v.distractorsValid) distractorsValid++;
      if (!isPassingVerdict(v)) baselineErrors++;
    }

    let sourceShipped = 0;
    let sourceShippedErrors = 0;
    let sourceRepaired = 0;
    let sourceFlagged = 0;
    for (const r of input.repaired) {
      if (r.verdict === "flagged") {
        sourceFlagged++;
        flaggedCount++;
        continue;
      }
      sourceShipped++;
      shippedCount++;
      if (r.verdict === "repaired") {
        sourceRepaired++;
        repairedCount++;
      }
      if (!r.postVerdict) {
        throw new Error(`${input.sourceId} shipped repaired question is missing post-repair verdict`);
      }
      if (!isPassingVerdict(r.postVerdict)) {
        sourceShippedErrors++;
        shippedErrors++;
      }
    }

    sourceResults.push({
      sourceId: input.sourceId,
      split: source.split,
      domain: source.domain,
      title: source.title,
      baseline: {
        total: input.baselineVerdicts.length,
        errors: input.baselineVerdicts.filter((v) => !isPassingVerdict(v)).length,
      },
      postRepair: {
        shipped: sourceShipped,
        errors: sourceShippedErrors,
        repaired: sourceRepaired,
        flagged: sourceFlagged,
      },
    });
  }

  const difficultyDistribution = {
    easy: round4(difficultyCounts.easy / Math.max(questionCount, 1)),
    medium: round4(difficultyCounts.medium / Math.max(questionCount, 1)),
    hard: round4(difficultyCounts.hard / Math.max(questionCount, 1)),
  };

  return {
    sourceCount: benchmarkInputs.length,
    questionCount,
    schemaValidity: wilson(schemaValid, questionCount),
    groundingRate: wilson(grounded, questionCount),
    answerKeyCorrectnessRate: wilson(answerSupported, questionCount),
    uniqueAnswerRate: wilson(uniqueAnswer, questionCount),
    distractorValidityRate: wilson(distractorsValid, questionCount),
    baselineErrorRate: wilson(baselineErrors, questionCount),
    postRepairShippedErrorRate: wilson(shippedErrors, shippedCount),
    repairRate: wilson(repairedCount, questionCount),
    removalRate: wilson(flaggedCount, questionCount),
    difficultyDistribution,
    sources: sourceResults,
  };
}

async function runOfflineBenchmark(sources: EvalSource[]): Promise<EvalReport["benchmark"]> {
  const fixtures = await readJson("eval/fixtures/benchmark-fixtures.json", benchmarkFixturesSchema);
  const sourceIds = new Set(sources.map((s) => s.id));
  const benchmarkInputs = fixtures.quizzes.map((fixture) => {
    if (!sourceIds.has(fixture.sourceId)) {
      throw new Error(`Benchmark fixture points to unknown source ${fixture.sourceId}`);
    }
    validateFixture(fixture);
    const repaired = applyOfflineRepair(fixture);
    return {
      sourceId: fixture.sourceId,
      generatorProvider: fixture.generatorProvider,
      generatorModel: fixture.generatorModel,
      verifierModel: fixture.verifierModel,
      quiz: fixture.quiz,
      baselineVerdicts: fixture.baselineVerdicts,
      repaired,
    };
  });
  return summarizeBenchmark(sources, benchmarkInputs);
}

async function runLiveBenchmark(
  sources: EvalSource[],
  repairVerifier: VerifierInfo,
  evalJudge: VerifierInfo
): Promise<EvalReport["benchmark"]> {
  const preferredProvider = process.env.LLM_PROVIDER ?? "hf";
  const benchmarkInputs = [];
  const runDeadline = Date.now() + 10 * 60_000;

  for (const source of sources) {
    const generationDeadline = Math.min(Date.now() + 120_000, runDeadline);
    const generated = await generateWithFallback(
      {
        sourceText: source.sourceText,
        questionCount: source.questionCount,
        seed: source.seed,
      },
      preferredProvider,
      generationDeadline
    );
    const quiz = shuffleQuizOptions(generated.quiz);
    // Baseline is scored by the INDEPENDENT eval judge (not the repair verifier).
    const baselineVerdicts = await verifyQuestions(
      source.sourceText,
      quiz.questions.map((q) => ({
        stem: q.stem,
        options: q.options,
        correctOptionId: q.correctOptionId,
      })),
      evalJudge
    );
    // Repair runs with the app's real verifier (drives the repair decisions).
    const repairedResult = await verifyAndRepair({
      material: source.sourceText,
      questions: quiz.questions,
      verifier: repairVerifier,
      deadline: Math.min(Date.now() + 120_000, runDeadline),
      seed: source.seed,
    });
    const shipped = repairedResult.questions.filter((r) => r.verdict !== "flagged");
    // Shipped questions are re-judged by the eval judge — independent of repair
    // when EVAL_JUDGE_PROVIDER differs from the repair verifier.
    const postVerdicts = shipped.length
      ? await verifyQuestions(
          source.sourceText,
          shipped.map((r) => ({
            stem: r.question.stem,
            options: r.question.options,
            correctOptionId: r.question.correctOptionId,
          })),
          evalJudge
        )
      : [];

    let postIndex = 0;
    const repaired: RepairedOfflineQuestion[] = repairedResult.questions.map((r, i) => {
      if (r.verdict === "flagged") {
        return { question: r.question, verdict: "flagged", baselineIndex: i, postVerdict: null };
      }
      const postVerdict = postVerdicts[postIndex++];
      return { question: r.question, verdict: r.verdict, baselineIndex: i, postVerdict };
    });

    benchmarkInputs.push({
      sourceId: source.id,
      generatorProvider: generated.provider,
      generatorModel: generated.provider === "gemini" ? geminiModelName() : HF_MODEL_NAME,
      verifierModel: evalJudge.model,
      quiz,
      baselineVerdicts,
      repaired,
    });
  }

  return summarizeBenchmark(sources, benchmarkInputs);
}

async function runCalibration(live: boolean, judge: VerifierInfo | null, cases: CalibrationCase[], sourceById: Map<string, EvalSource>): Promise<EvalReport["calibration"]> {
  if (!live) {
    return scoreCalibration(
      cases,
      cases.map((c, i) => fixtureCalibrationVerdict(c, i))
    );
  }

  if (!judge) throw new Error("Live calibration requires HF_API_KEY or GEMINI_API_KEY for the eval judge");

  const predictions: QuestionVerdict[] = new Array(cases.length);
  const casesBySource = new Map<string, { c: CalibrationCase, originalIndex: number }[]>();
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (!casesBySource.has(c.sourceId)) casesBySource.set(c.sourceId, []);
    casesBySource.get(c.sourceId)!.push({ c, originalIndex: i });
  }

  for (const [sourceId, grouped] of casesBySource) {
    const source = sourceById.get(sourceId);
    if (!source) throw new Error(`Calibration case points to unknown source ${sourceId}`);
    const questions = grouped.map((g) => g.c.question);
    const verdicts = await verifyQuestions(source.sourceText, questions, judge);
    for (let j = 0; j < grouped.length; j++) {
      predictions[grouped[j].originalIndex] = { ...verdicts[j], index: grouped[j].originalIndex };
    }
  }

  return scoreCalibration(cases, predictions);
}

function renderMarkdown(report: EvalReport): string {
  const b = report.benchmark;
  const c = report.calibration;
  const lines: string[] = [];
  lines.push("# Quality Engine Phase 2 Eval Report");
  lines.push("");
  if (report.config.synthetic) {
    lines.push(
      "> ⚠️ **OFFLINE FIXTURE MODE — these numbers are synthetic harness validation, NOT measurements.**"
    );
    lines.push(
      "> The baseline verdicts and judge predictions are hand-authored fixtures used to test the"
    );
    lines.push(
      "> metric plumbing. Do **not** cite them as results. Run `npm run eval:live` for real metrics."
    );
    lines.push("");
  }
  lines.push(`Mode: ${report.config.live ? "live providers" : "offline fixtures (synthetic)"}`);
  lines.push(`Generated: ${report.config.generatedAt}`);
  if (report.config.live) {
    lines.push(`Generator: ${report.config.generatorProvider}`);
    lines.push(`Eval judge (scores + calibration): ${report.config.evalJudgeProvider} · ${report.config.evalJudgeModel}`);
    lines.push(`Repair verifier (drives repairs): ${report.config.repairVerifierProvider} · ${report.config.repairVerifierModel}`);
    lines.push(
      `Post-repair independence: ${report.config.postRepairIndependent ? "yes (eval judge ≠ repair verifier)" : "no (eval judge == repair verifier — post-repair is self-consistency, not an independent re-judge)"}`
    );
  }
  lines.push(`Generator prompt hash: ${report.config.promptHashes.generator}`);
  lines.push(`Verifier prompt hash: ${report.config.promptHashes.verifier}`);
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  if (report.config.synthetic) {
    lines.push("_(synthetic fixture — illustrative of the metric plumbing only)_");
    lines.push("");
  }
  lines.push(
    `Calibration vs. human labels: Cohen's κ ${c.cohenKappa.toFixed(4)} (${c.status}) over ${c.caseCount} cases — the credibility anchor for the eval judge.`
  );
  lines.push(
    `Baseline error rate (independent ${report.config.live ? report.config.evalJudgeProvider : "fixture"} judge): ${b.baselineErrorRate.count}/${b.baselineErrorRate.total} (${percentage(b.baselineErrorRate.rate)}, 95% CI ${percentage(b.baselineErrorRate.wilson95.low)}-${percentage(b.baselineErrorRate.wilson95.high)}).`
  );
  lines.push(`Repair rate: ${percentage(b.repairRate.rate)}. Removal rate: ${percentage(b.removalRate.rate)}.`);
  const postLabel = report.config.postRepairIndependent
    ? "Post-repair shipped-question error rate (independent re-judge)"
    : "Post-repair shipped error (same model that approved them — self-consistency, NOT independent)";
  lines.push(
    `${postLabel}: ${b.postRepairShippedErrorRate.count}/${b.postRepairShippedErrorRate.total} (${percentage(b.postRepairShippedErrorRate.rate)}, 95% CI ${percentage(b.postRepairShippedErrorRate.wilson95.low)}-${percentage(b.postRepairShippedErrorRate.wilson95.high)}).`
  );
  lines.push("");
  lines.push("## Calibration");
  lines.push("");
  lines.push(`Status: ${c.status}`);
  lines.push(`Cases: ${c.caseCount}`);
  lines.push(`Accuracy: ${percentage(c.accuracy)}`);
  lines.push(`Precision: ${percentage(c.precision)}`);
  lines.push(`Recall: ${percentage(c.recall)}`);
  lines.push(`F1: ${percentage(c.f1)}`);
  lines.push(`Cohen kappa: ${c.cohenKappa.toFixed(4)}`);
  lines.push("");
  lines.push("### Confusion Matrix");
  lines.push("");
  lines.push(`| | Predicted Error | Predicted Pass |`);
  lines.push(`|---|---|---|`);
  lines.push(`| **Actual Error** | TP: ${c.confusion.tp} | FN: ${c.confusion.fn} |`);
  lines.push(`| **Actual Pass** | FP: ${c.confusion.fp} | TN: ${c.confusion.tn} |`);
  lines.push("");
  lines.push("### Dimension Agreement");
  lines.push("");
  lines.push(`| Dimension | Agreement Rate |`);
  lines.push(`|---|---|`);
  lines.push(`| Grounded | ${percentage(c.dimensionAgreement.grounded)} |`);
  lines.push(`| Answer Supported | ${percentage(c.dimensionAgreement.answerSupported)} |`);
  lines.push(`| Unique Answer | ${percentage(c.dimensionAgreement.uniqueAnswer)} |`);
  lines.push(`| Distractors Valid | ${percentage(c.dimensionAgreement.distractorsValid)} |`);
  lines.push(`| Correct Option ID | ${percentage(c.dimensionAgreement.correctOptionId)} |`);
  lines.push("");
  lines.push("## Benchmark Metrics");
  lines.push("");
  lines.push(`Schema validity: ${percentage(b.schemaValidity.rate)}`);
  lines.push(`Grounding rate: ${percentage(b.groundingRate.rate)}`);
  lines.push(`Answer-key correctness: ${percentage(b.answerKeyCorrectnessRate.rate)}`);
  lines.push(`Unique-answer rate: ${percentage(b.uniqueAnswerRate.rate)}`);
  lines.push(`Distractor validity: ${percentage(b.distractorValidityRate.rate)}`);
  lines.push(
    `Difficulty distribution: easy ${percentage(b.difficultyDistribution.easy)}, medium ${percentage(b.difficultyDistribution.medium)}, hard ${percentage(b.difficultyDistribution.hard)}.`
  );
  lines.push("");
  lines.push("## Source Results");
  lines.push("");
  lines.push("| Source | Split | Baseline errors | Shipped errors | Repaired | Removed |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const source of b.sources) {
    lines.push(
      `| ${source.title} | ${source.split} | ${source.baseline.errors}/${source.baseline.total} | ${source.postRepair.errors}/${source.postRepair.shipped} | ${source.postRepair.repaired} | ${source.postRepair.flagged} |`
    );
  }
  lines.push("");
  lines.push("## Caveats");
  lines.push("");
  lines.push("- Offline fixture mode is deterministic and cost-safe but SYNTHETIC: its numbers are hand-authored to test plumbing, never a result. Use `npm run eval:live` for real metrics.");
  lines.push("- The defensible headline is the calibrated judge's κ vs. humans + the baseline error rate it (independently of generation) catches.");
  lines.push("- With only two providers a single judge can be independent of generation OR of repair, not both. When the eval judge equals the repair verifier, the post-repair number is self-consistency — set `EVAL_JUDGE_PROVIDER` to the non-repair provider (or add a 3rd model / human re-labeling) for an independent post-repair rate.");
  lines.push("- The first calibration set is intentionally compact (50 cases); widen the corpus before using the number as a formal product claim.");
  lines.push("- Flagged questions are counted as removed, not shipped errors, matching the app's Phase 1 play/scoring behavior.");
  lines.push("");
  return lines.join("\n");
}

async function writeReports(report: EvalReport): Promise<void> {
  await mkdir(reportsDir, { recursive: true });
  await writeFile(path.join(reportsDir, "phase2-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(reportsDir, "phase2-latest.md"), renderMarkdown(report));
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  const sourcesDataset = await readJson("eval/datasets/phase2-sources.json", phase2SourcesSchema);
  const calibrationDataset = await readJson(
    "eval/datasets/calibration-cases.json",
    calibrationDatasetSchema
  );
  const sources = sourcesDataset.sources;
  const calibrationCases = calibrationDataset.cases;
  assertDatasetIntegrity(sources, calibrationCases);

  const liveVerifier = live ? selectVerifier() : null;
  if (live && !liveVerifier) {
    throw new Error("Live eval requires HF_API_KEY or GEMINI_API_KEY for verifier selection");
  }
  const evalJudge = live ? selectEvalJudge() : null;
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  // The eval judge (not the repair verifier) produces the numbers we report, so
  // it is the model we calibrate against the human labels.
  const calibration = await runCalibration(live, evalJudge, calibrationCases, sourceById);
  const benchmark = live
    ? await runLiveBenchmark(sources, liveVerifier as VerifierInfo, evalJudge as VerifierInfo)
    : await runOfflineBenchmark(sources);

  const postRepairIndependent =
    live && !!evalJudge && !!liveVerifier && evalJudge.provider !== liveVerifier.provider;

  const report: EvalReport = {
    version: 1,
    config: {
      live,
      synthetic: !live,
      generatedAt: live ? new Date().toISOString() : "offline-fixture-v1",
      generatorProvider: live ? process.env.LLM_PROVIDER ?? "hf" : "fixture",
      repairVerifierProvider: live ? (liveVerifier as VerifierInfo).provider : "fixture",
      repairVerifierModel: live ? (liveVerifier as VerifierInfo).model : "fixture-verifier-v1",
      evalJudgeProvider: live ? (evalJudge as VerifierInfo).provider : "fixture",
      evalJudgeModel: live ? (evalJudge as VerifierInfo).model : "fixture-judge-v1",
      postRepairIndependent,
      promptHashes: {
        generator: hashText(SYSTEM_PROMPT),
        verifier: hashText(VERIFIER_SYSTEM_PROMPT),
      },
    },
    calibration,
    benchmark,
  };

  if (benchmark.postRepairShippedErrorRate.total + benchmark.removalRate.count !== benchmark.questionCount) {
    throw new Error("Report invariant failed: flagged questions leaked into shipped denominator");
  }

  await writeReports(report);

  console.log(`Quality Engine Phase 2 eval complete (${live ? "live" : "offline fixture"} mode).`);
  if (report.config.synthetic) {
    console.log("⚠️  SYNTHETIC fixture numbers — harness validation only, NOT measurements. Run `npm run eval:live` for real metrics.");
  } else {
    console.log(
      `Eval judge: ${report.config.evalJudgeProvider}:${report.config.evalJudgeModel} | repair verifier: ${report.config.repairVerifierProvider}:${report.config.repairVerifierModel} | post-repair independent: ${report.config.postRepairIndependent}`
    );
  }
  console.log(`Calibration kappa (eval judge vs humans): ${report.calibration.cohenKappa.toFixed(4)} (${report.calibration.status})`);
  console.log(
    `Baseline error rate: ${report.benchmark.baselineErrorRate.count}/${report.benchmark.baselineErrorRate.total} (${percentage(report.benchmark.baselineErrorRate.rate)})`
  );
  console.log(
    `Post-repair shipped error rate: ${report.benchmark.postRepairShippedErrorRate.count}/${report.benchmark.postRepairShippedErrorRate.total} (${percentage(report.benchmark.postRepairShippedErrorRate.rate)})${report.config.postRepairIndependent ? "" : " [self-consistency, not independent]"}`
  );
  console.log("Reports written to eval/reports/phase2-latest.{json,md}");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
