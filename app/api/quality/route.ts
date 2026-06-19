import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";

// Empty-but-valid shape so the client can render a clean empty state on any error.
const EMPTY = {
  quizzesVerified: 0,
  questionsChecked: 0,
  initialErrorRate: 0,
  repairRate: 0,
  removalRate: 0,
  unverifiedRate: 0,
  verdictDistribution: { pass: 0, repaired: 0, flagged: 0, unverified: 0 },
  byVerifierModel: [] as { model: string; checked: number; repaired: number; flagged: number }[],
  qualityOverTime: [] as { date: string; checked: number; caught: number }[],
  pipeline: {
    firstBatchLatencyP50Ms: 0,
    firstBatchLatencyP95Ms: 0,
    fullQuizLatencyP50Ms: 0,
    fullQuizLatencyP95Ms: 0,
    citationCoverage: 0,
    verifierCompletionRate: 0,
    batchRetryRate: 0,
    batchFailureRate: 0,
    averageGeneratedQuestions: 0,
    averageRequestedQuestions: 0,
  },
};

export async function GET() {
  try {
    return await buildQuality();
  } catch (err) {
    console.error("[quality] failed:", err);
    return NextResponse.json(EMPTY, { status: 200 });
  }
}

type VerdictRow = { verdict: string | null; total: bigint | number };
type Summary = {
  total?: number;
  failedInitial?: number;
  repaired?: number;
  flagged?: number;
  unverified?: number;
};
const n = (v: bigint | number | null) => Number(v ?? 0);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const percentile = (values: number[], value: number) => {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(value * sorted.length) - 1)];
};

export async function buildQuality() {
  const userId = await getCurrentUserId();

  // Question-level verdict distribution — aggregated in SQL (stays small as data grows).
  const verdictRows = await prisma.$queryRaw<VerdictRow[]>`
    SELECT q."verdict" AS verdict, COUNT(*) AS total
    FROM "Question" q
    JOIN "Quiz" z ON z."id" = q."quizId"
    WHERE z."userId" = ${userId}
    GROUP BY q."verdict"`;

  const verdictDistribution = { pass: 0, repaired: 0, flagged: 0, unverified: 0 };
  for (const r of verdictRows) {
    const c = n(r.total);
    if (r.verdict === "pass") verdictDistribution.pass += c;
    else if (r.verdict === "repaired") verdictDistribution.repaired += c;
    else if (r.verdict === "flagged") verdictDistribution.flagged += c;
    else verdictDistribution.unverified += c;
  }

  // Verified quizzes carry a summary JSON + provenance — bounded set, parse in JS.
  const verifiedQuizzes = await prisma.quiz.findMany({
    where: { userId, verificationStatus: "verified" },
    orderBy: { verifiedAt: "asc" },
    select: { verifiedAt: true, verifierModel: true, verificationSummary: true },
  });

  let questionsChecked = 0;
  let failedInitial = 0;
  let repaired = 0;
  let flagged = 0;
  let unverified = 0;
  const byModel = new Map<string, { checked: number; repaired: number; flagged: number }>();
  const qualityOverTime: { date: string; checked: number; caught: number }[] = [];

  for (const q of verifiedQuizzes) {
    let s: Summary = {};
    try {
      s = q.verificationSummary ? (JSON.parse(q.verificationSummary) as Summary) : {};
    } catch {
      s = {};
    }
    const total = n(s.total ?? 0);
    const fi = n(s.failedInitial ?? 0);
    const rp = n(s.repaired ?? 0);
    const fl = n(s.flagged ?? 0);
    const uv = n(s.unverified ?? 0);

    questionsChecked += total;
    failedInitial += fi;
    repaired += rp;
    flagged += fl;
    unverified += uv;

    const model = q.verifierModel ?? "unknown";
    const m = byModel.get(model) ?? { checked: 0, repaired: 0, flagged: 0 };
    m.checked += total;
    m.repaired += rp;
    m.flagged += fl;
    byModel.set(model, m);

    qualityOverTime.push({
      date: (q.verifiedAt ?? new Date()).toISOString().slice(0, 10),
      checked: total,
      caught: fi,
    });
  }

  const pipelineQuizzes = await prisma.quiz.findMany({
    where: { userId, sourceDocumentId: { not: null } },
    select: {
      createdAt: true,
      firstBatchReadyAt: true,
      questionCount: true,
      targetQuestionCount: true,
      generationBatches: {
        select: { completedAt: true, attemptCount: true, status: true },
      },
      questions: {
        select: { evidenceStatus: true, verdict: true },
      },
    },
  });
  const firstBatchLatencies = pipelineQuizzes
    .filter((quiz) => quiz.firstBatchReadyAt)
    .map(
      (quiz) =>
        (quiz.firstBatchReadyAt as Date).getTime() - quiz.createdAt.getTime()
    );
  const fullQuizLatencies = pipelineQuizzes.flatMap((quiz) => {
    const completed = quiz.generationBatches
      .map((batch) => batch.completedAt?.getTime() ?? 0)
      .filter(Boolean);
    return completed.length > 0
      ? [Math.max(...completed) - quiz.createdAt.getTime()]
      : [];
  });
  const pipelineQuestions = pipelineQuizzes.flatMap((quiz) => quiz.questions);
  const pipelineBatches = pipelineQuizzes.flatMap(
    (quiz) => quiz.generationBatches
  );
  const requestedTotal = pipelineQuizzes.reduce(
    (sum, quiz) => sum + (quiz.targetQuestionCount ?? quiz.questionCount),
    0
  );
  const generatedTotal = pipelineQuizzes.reduce(
    (sum, quiz) => sum + quiz.questionCount,
    0
  );

  return NextResponse.json({
    quizzesVerified: verifiedQuizzes.length,
    questionsChecked,
    // % of generated questions an independent verifier initially found wrong/ungrounded.
    initialErrorRate: pct(failedInitial, questionsChecked),
    repairRate: pct(repaired, questionsChecked),
    removalRate: pct(flagged, questionsChecked),
    unverifiedRate: pct(unverified, questionsChecked),
    verdictDistribution,
    byVerifierModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v })),
    qualityOverTime,
    pipeline: {
      firstBatchLatencyP50Ms: percentile(firstBatchLatencies, 0.5),
      firstBatchLatencyP95Ms: percentile(firstBatchLatencies, 0.95),
      fullQuizLatencyP50Ms: percentile(fullQuizLatencies, 0.5),
      fullQuizLatencyP95Ms: percentile(fullQuizLatencies, 0.95),
      citationCoverage: pct(
        pipelineQuestions.filter((question) => question.evidenceStatus === "valid")
          .length,
        pipelineQuestions.length
      ),
      verifierCompletionRate: pct(
        pipelineQuestions.filter((question) => question.verdict !== "unverified")
          .length,
        pipelineQuestions.length
      ),
      batchRetryRate: pct(
        pipelineBatches.filter((batch) => batch.attemptCount > 1).length,
        pipelineBatches.length
      ),
      batchFailureRate: pct(
        pipelineBatches.filter((batch) => batch.status === "failed").length,
        pipelineBatches.length
      ),
      averageGeneratedQuestions:
        pipelineQuizzes.length > 0
          ? Math.round((generatedTotal / pipelineQuizzes.length) * 10) / 10
          : 0,
      averageRequestedQuestions:
        pipelineQuizzes.length > 0
          ? Math.round((requestedTotal / pipelineQuizzes.length) * 10) / 10
          : 0,
    },
  });
}
