import Link from "next/link";
import { notFound } from "next/navigation";
import NavBar from "@/app/components/NavBar";
import { getCurrentUserId } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import LessonActions from "./LessonActions";

type LessonSection = { heading: string; body: string };

export default async function CoachLessonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await getCurrentUserId();
  const { id } = await params;
  const lesson = await prisma.coachLesson.findFirst({
    where: { id, studyPlan: { userId } },
    include: {
      studyPlan: { select: { examTitle: true } },
      evidence: {
        orderBy: { displayOrder: "asc" },
        include: {
          sourceChunk: {
            include: {
              sourceDocument: {
                select: { title: true, originUrl: true },
              },
              references: {
                include: { sourceReference: true },
              },
            },
          },
        },
      },
    },
  });
  if (!lesson) notFound();

  const sections = JSON.parse(lesson.sections) as LessonSection[];
  return (
    <>
      <NavBar />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <Link
          href="/dashboard"
          className="mb-6 inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-foreground"
        >
          ← Study plan
        </Link>

        <article className="glass-card p-6 sm:p-8">
          <div className="mb-5">
            <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-700">
              Cited coach lesson
            </span>
            <p className="mt-3 text-sm text-muted">{lesson.studyPlan.examTitle}</p>
            <h1
              className="mt-1 text-3xl font-bold tracking-tight"
              style={{ fontFamily: "var(--font-jakarta)" }}
            >
              {lesson.title}
            </h1>
          </div>

          <div className="space-y-6">
            {sections.map((section) => (
              <section key={section.heading}>
                <h2 className="text-lg font-semibold">{section.heading}</h2>
                <p className="mt-2 whitespace-pre-line text-sm leading-7">
                  {section.body}
                </p>
              </section>
            ))}

            <section
              className="rounded-xl px-4 py-4"
              style={{ backgroundColor: "var(--surface-sunk)" }}
            >
              <h2 className="text-sm font-semibold">Common misconception</h2>
              <p className="mt-2 text-sm leading-6">{lesson.misconception}</p>
            </section>

            {lesson.workedExample && (
              <section>
                <h2 className="text-lg font-semibold">Worked example</h2>
                <p className="mt-2 whitespace-pre-line text-sm leading-7">
                  {lesson.workedExample}
                </p>
              </section>
            )}

            <section
              className="rounded-xl px-4 py-4"
              style={{ backgroundColor: "var(--primary-soft)" }}
            >
              <h2 className="text-sm font-semibold">Summary</h2>
              <p className="mt-2 text-sm leading-6">{lesson.summary}</p>
            </section>

            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
                Supporting evidence
              </h2>
              <div className="mt-3 space-y-3">
                {lesson.evidence.map((evidence) => {
                  const reference =
                    evidence.sourceChunk.references[0]?.sourceReference;
                  return (
                    <div
                      key={evidence.id}
                      className="rounded-xl border px-4 py-3 text-sm leading-6"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <p>&ldquo;{evidence.quote}&rdquo;</p>
                      <p className="mt-2 text-xs text-muted">
                        {reference ? (
                          <a
                            href={reference.url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium underline"
                          >
                            {reference.title}
                          </a>
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
            </section>
          </div>

          <LessonActions lessonId={lesson.id} />
        </article>
      </main>
    </>
  );
}
