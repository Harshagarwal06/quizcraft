import Link from "next/link";
import { notFound } from "next/navigation";
import NavBar from "@/app/components/NavBar";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";

type OptionId = "A" | "B" | "C" | "D";
type Option = { id: OptionId; text: string };

const sourceTypeLabel: Record<string, string> = {
  pdf: "PDF",
  notes: "Notes",
  prompt: "Prompt",
};

const difficultyColor: Record<string, string> = {
  easy: "bg-emerald-100 text-emerald-700",
  medium: "bg-amber-100 text-amber-700",
  hard: "bg-rose-100 text-rose-700",
};

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function parseOptions(value: string): Option[] {
  try {
    return JSON.parse(value) as Option[];
  } catch {
    return [];
  }
}

function parseOptionExplanations(
  value: string | null
): Partial<Record<OptionId, string>> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Partial<Record<OptionId, string>>;
  } catch {
    return {};
  }
}

export default async function ViewQuizPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await getCurrentUserId();
  const { id } = await params;
  const quiz = await prisma.quiz.findFirst({
    where: { id, userId, purpose: "standard" },
    select: {
      id: true,
      title: true,
      sourceType: true,
      sourceDocumentId: true,
      createdAt: true,
      _count: { select: { attempts: true } },
      questions: {
        orderBy: { order: "asc" },
        select: {
          id: true,
          stem: true,
          options: true,
          correctOption: true,
          explanation: true,
          optionExplanations: true,
          difficulty: true,
          topic: true,
          verdict: true,
          evidenceStatus: true,
          evidence: {
            orderBy: { displayOrder: "asc" },
            select: {
              quote: true,
              sourceChunk: {
                select: {
                  pageStart: true,
                  section: true,
                  sourceDocument: { select: { title: true, originUrl: true } },
                  references: {
                    select: {
                      sourceReference: {
                        select: { title: true, url: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!quiz) notFound();

  const questions = quiz.questions.filter((question) =>
    quiz.sourceDocumentId
      ? (question.verdict === "pass" || question.verdict === "repaired") &&
        question.evidenceStatus === "valid"
      : question.verdict !== "flagged" && question.verdict !== "unverified"
  );

  return (
    <>
      <NavBar />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <Link
          href="/quizzes"
          className="mb-6 inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-foreground"
        >
          <span aria-hidden="true">←</span>
          My quizzes
        </Link>

        <section className="glass-card mb-6 p-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
                  Read-only view
                </span>
                <span className="text-xs text-muted">
                  {sourceTypeLabel[quiz.sourceType] ?? quiz.sourceType}
                </span>
              </div>
              <h1
                className="text-2xl font-bold tracking-tight"
                style={{ fontFamily: "var(--font-jakarta)" }}
              >
                {quiz.title}
              </h1>
              <p className="mt-2 text-sm text-muted">
                {questions.length} questions · {quiz._count.attempts}{" "}
                {quiz._count.attempts === 1 ? "attempt" : "attempts"} ·{" "}
                {formatDate(quiz.createdAt)}
              </p>
            </div>
            <Link href={`/quiz/${quiz.id}`} className="btn-primary text-center">
              Play quiz
            </Link>
          </div>
        </section>

        {questions.length === 0 ? (
          <section className="glass-card p-8 text-center">
            <p className="font-medium">No verified questions are available.</p>
            <p className="mt-2 text-sm text-muted">
              Retry this quiz from the player after verification completes.
            </p>
          </section>
        ) : (
          <div className="space-y-4">
            {questions.map((question, index) => {
              const options = parseOptions(question.options);
              const optionExplanations = parseOptionExplanations(
                question.optionExplanations
              );

              return (
                <article key={question.id} className="glass-card p-6">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-muted">
                      Question {index + 1}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        difficultyColor[question.difficulty] ??
                        "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {question.difficulty}
                    </span>
                    <span className="text-xs text-muted">{question.topic}</span>
                    {question.verdict === "repaired" && (
                      <span className="ml-auto rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
                        Repaired
                      </span>
                    )}
                  </div>

                  <h2 className="mb-4 font-semibold leading-relaxed">
                    {question.stem}
                  </h2>

                  <div className="space-y-2">
                    {options.map((option) => {
                      const isCorrect = option.id === question.correctOption;
                      return (
                        <div
                          key={option.id}
                          className={`rounded-xl border px-4 py-3 text-sm ${
                            isCorrect
                              ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                              : "text-foreground"
                          }`}
                          style={
                            isCorrect
                              ? undefined
                              : {
                                  borderColor: "var(--border)",
                                  backgroundColor: "var(--surface)",
                                }
                          }
                        >
                          <div className="flex gap-2">
                            <span className="font-mono font-semibold">
                              {option.id}.
                            </span>
                            <span className="flex-1">
                              {option.text}
                              {isCorrect && (
                                <span className="ml-2 font-semibold text-emerald-700">
                                  ✓ Correct
                                </span>
                              )}
                            </span>
                          </div>
                          {optionExplanations[option.id] && (
                            <p className="mt-2 pl-6 text-xs leading-relaxed text-muted">
                              {optionExplanations[option.id]}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <div
                    className="mt-4 rounded-xl px-4 py-3 text-sm leading-relaxed"
                    style={{ backgroundColor: "var(--primary-soft)" }}
                  >
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                      Explanation
                    </p>
                    {question.explanation}
                  </div>

                  {question.evidence.length > 0 && (
                    <div className="mt-4 space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                        Supporting evidence
                      </p>
                      {question.evidence.map((evidence, evidenceIndex) => {
                        const references = evidence.sourceChunk.references.map(
                          ({ sourceReference }) => sourceReference
                        );
                        return (
                          <div
                            key={`${question.id}-evidence-${evidenceIndex}`}
                            className="rounded-xl border px-4 py-3 text-sm leading-relaxed"
                            style={{ borderColor: "var(--border)" }}
                          >
                            <p>&ldquo;{evidence.quote}&rdquo;</p>
                            <p className="mt-2 text-xs text-muted">
                              {references.length > 0 ? (
                                references.map((reference, referenceIndex) => (
                                  <span key={reference.url}>
                                    {referenceIndex > 0 && " · "}
                                    <a
                                      href={reference.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="font-medium underline"
                                    >
                                      {reference.title}
                                    </a>
                                  </span>
                                ))
                              ) : evidence.sourceChunk.sourceDocument.originUrl ? (
                                <a
                                  href={evidence.sourceChunk.sourceDocument.originUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="font-medium underline"
                                >
                                  {evidence.sourceChunk.sourceDocument.title}
                                </a>
                              ) : (
                                evidence.sourceChunk.sourceDocument.title
                              )}
                              {evidence.sourceChunk.pageStart
                                ? ` · page ${evidence.sourceChunk.pageStart}`
                                : evidence.sourceChunk.section
                                  ? ` · ${evidence.sourceChunk.section}`
                                  : ""}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}
