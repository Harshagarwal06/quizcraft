import type { CoachCandidate, CoachToolName } from "./types";

const DAY_MS = 86_400_000;

export type CoachConceptState = {
  conceptKey: string;
  label: string;
  importance: number;
  answered: number;
  incorrect: number;
  lastAnsweredAt: Date | null;
  lastIncorrectAt: Date | null;
  lastLessonAt: Date | null;
  sourceDocumentId: string;
  sourceQuizId: string | null;
};

export type DueReviewState = {
  sourceQuizId: string;
  sourceDocumentId: string;
  quizTitle: string;
  concepts: { conceptKey: string; label: string; stage: number }[];
};

export function smoothedWeakness(incorrect: number, answered: number): number {
  return (incorrect + 1) / (answered + 2);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function conceptPriorityScore(
  concept: CoachConceptState,
  examDate: Date,
  now: Date
): number {
  const weakness = smoothedWeakness(concept.incorrect, concept.answered);
  const daysSinceActivity = concept.lastAnsweredAt
    ? Math.max(0, (now.getTime() - concept.lastAnsweredAt.getTime()) / DAY_MS)
    : 14;
  const recency = clamp(daysSinceActivity / 14);
  const daysUntilExam = Math.max(
    0,
    (examDate.getTime() - now.getTime()) / DAY_MS
  );
  const urgency = clamp(1 - daysUntilExam / 90);
  return (
    0.45 * weakness +
    0.25 * clamp(concept.importance) +
    0.2 * recency +
    0.1 * urgency
  );
}

function candidate(
  value: Omit<CoachCandidate, "id"> & { id?: string }
): CoachCandidate {
  const signature = [
    value.type,
    value.sourceDocumentIds.join(","),
    value.conceptKeys.join(","),
  ].join(":");
  return { ...value, id: value.id ?? signature };
}

export function buildCoachCandidates(input: {
  concepts: CoachConceptState[];
  dueReviews: DueReviewState[];
  examDate: Date;
  now: Date;
  sourceCount: number;
}): CoachCandidate[] {
  if (input.sourceCount === 0 || input.concepts.length === 0) {
    return [
      candidate({
        type: "request_source",
        tool: "request_additional_material",
        title: "Add study material",
        reason:
          "Your coach needs an evidence-backed PDF, notes, or grounded topic before it can teach or test you.",
        estimatedMinutes: 3,
        conceptKeys: [],
        sourceDocumentIds: [],
        score: 10_000,
      }),
    ];
  }

  if (input.examDate.getTime() < input.now.getTime()) {
    return [
      candidate({
        type: "rest",
        tool: null,
        title: "Review your study goal",
        reason:
          "The exam date on this plan has passed. Update the plan before generating more work.",
        estimatedMinutes: 2,
        conceptKeys: [],
        sourceDocumentIds: [],
        score: 10_000,
      }),
    ];
  }

  const candidates: CoachCandidate[] = [];
  for (const due of input.dueReviews) {
    const selected = due.concepts.slice(0, 3);
    candidates.push(
      candidate({
        type: "review",
        tool: "generate_targeted_review",
        title: `Review ${due.quizTitle}`,
        reason: `${selected.length} concept${
          selected.length === 1 ? " is" : "s are"
        } due now. Spaced review takes priority over new material.`,
        estimatedMinutes: Math.max(6, selected.length * 4),
        conceptKeys: selected.map((item) => item.conceptKey),
        sourceDocumentIds: [due.sourceDocumentId],
        payload: { sourceQuizId: due.sourceQuizId },
        score: 1000 - Math.min(...selected.map((item) => item.stage)),
      })
    );
  }

  const ranked = input.concepts
    .map((concept) => ({
      concept,
      score: conceptPriorityScore(
        concept,
        input.examDate,
        input.now
      ),
    }))
    .sort((a, b) => b.score - a.score);

  for (const item of ranked) {
    const { concept, score } = item;
    const missedWithoutLesson =
      concept.incorrect > 0 &&
      concept.lastIncorrectAt !== null &&
      (!concept.lastLessonAt ||
        concept.lastLessonAt.getTime() < concept.lastIncorrectAt.getTime());
    const unseen = concept.answered === 0;
    if (missedWithoutLesson || unseen) {
      candidates.push(
        candidate({
          type: "lesson",
          tool: "generate_cited_lesson",
          title: `Learn ${concept.label}`,
          reason: missedWithoutLesson
            ? `You recently missed ${concept.label} and have not completed a remediation lesson since.`
            : `${concept.label} is important source material you have not practiced yet.`,
          estimatedMinutes: 5,
          conceptKeys: [concept.conceptKey],
          sourceDocumentIds: [concept.sourceDocumentId],
          payload: { sourceQuizId: concept.sourceQuizId },
          score: 100 + score,
        })
      );
    }
  }

  const quizConcepts = ranked.slice(0, 3).map((item) => item.concept);
  if (quizConcepts.length > 0) {
    const primarySource = quizConcepts[0].sourceDocumentId;
    const sameSource = quizConcepts
      .filter((concept) => concept.sourceDocumentId === primarySource)
      .slice(0, 3);
    candidates.push(
      candidate({
        type: "quiz",
        tool: "generate_standard_quiz",
        title: "Take a focused quiz",
        reason:
          "A mixed quiz will measure your current understanding and give the coach fresh evidence for the next decision.",
        estimatedMinutes: 10,
        conceptKeys: sameSource.map((concept) => concept.conceptKey),
        sourceDocumentIds: [primarySource],
        payload: { questionCount: 6 },
        score:
          10 +
          Math.max(
            ...sameSource.map((concept) =>
              conceptPriorityScore(concept, input.examDate, input.now)
            )
          ),
      })
    );
  }

  return candidates.sort((a, b) => b.score - a.score);
}

export function actionTool(type: CoachCandidate["type"]): CoachToolName | null {
  if (type === "lesson") return "generate_cited_lesson";
  if (type === "quiz") return "generate_standard_quiz";
  if (type === "review") return "generate_targeted_review";
  if (type === "request_source") return "request_additional_material";
  return null;
}
