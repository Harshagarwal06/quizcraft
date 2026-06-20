export const REVIEW_INTERVAL_DAYS = [1, 3, 7, 14, 30] as const;
export const MASTERY_STAGE = 6;

export type ConceptState = {
  conceptKey: string;
  label: string;
  stage: number;
  consecutiveCorrect: number;
  dueAt: Date | null;
};

export type ConceptTransition = ConceptState & {
  previousStage: number;
  status: "advanced" | "reset" | "progress" | "unchanged";
  lastReviewedAt: Date;
  mastered: boolean;
};

export type DueConcept = ConceptState & {
  createdAt?: Date;
};

export function normalizeConceptKey(label: string): string {
  const normalized = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
  return normalized || "general";
}

export function collectStandardMistakes(
  answers: { topic: string; isCorrect: boolean }[]
): Map<string, string> {
  const mistakes = new Map<string, string>();
  for (const answer of answers) {
    if (!answer.isCorrect) {
      mistakes.set(normalizeConceptKey(answer.topic), answer.topic.trim());
    }
  }
  return mistakes;
}

export function selectDueConcepts(
  concepts: DueConcept[],
  now: Date,
  limit = 3
): DueConcept[] {
  return concepts
    .filter(
      (concept) =>
        concept.stage < MASTERY_STAGE &&
        concept.dueAt !== null &&
        concept.dueAt.getTime() <= now.getTime()
    )
    .sort((a, b) => {
      if (a.stage !== b.stage) return a.stage - b.stage;
      const dueDiff = (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0);
      if (dueDiff !== 0) return dueDiff;
      return (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);
    })
    .slice(0, limit);
}

export function selectRequestedDueConcepts(
  concepts: DueConcept[],
  now: Date,
  requestedKeys?: string[],
  limit = 3
):
  | { ok: true; concepts: DueConcept[] }
  | { ok: false; reason: string } {
  if (!requestedKeys) {
    return { ok: true, concepts: selectDueConcepts(concepts, now, limit) };
  }
  const unique = [...new Set(requestedKeys)];
  if (
    unique.length === 0 ||
    unique.length > limit ||
    unique.length !== requestedKeys.length
  ) {
    return {
      ok: false,
      reason: `Choose between one and ${limit} unique due concepts.`,
    };
  }
  const due = new Map(
    selectDueConcepts(concepts, now, concepts.length).map((concept) => [
      concept.conceptKey,
      concept,
    ])
  );
  const selected = unique.map((key) => due.get(key));
  if (selected.some((concept) => !concept)) {
    return {
      ok: false,
      reason: "Every requested concept must currently be due for this quiz.",
    };
  }
  return { ok: true, concepts: selected as DueConcept[] };
}

function addUtcDays(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

export function applyReviewAnswers(
  current: ConceptState,
  answers: boolean[],
  now: Date
): ConceptTransition {
  const previousStage = current.stage;
  let stage = current.stage;
  let consecutiveCorrect = current.consecutiveCorrect;
  let dueAt = current.dueAt;
  let advanced = false;
  let reset = false;

  for (const correct of answers) {
    if (!correct) {
      stage = 0;
      consecutiveCorrect = 0;
      dueAt = now;
      reset = true;
      advanced = false;
      continue;
    }

    if (advanced || stage >= MASTERY_STAGE) continue;
    consecutiveCorrect += 1;
    if (consecutiveCorrect < 2) continue;

    stage = Math.min(MASTERY_STAGE, stage + 1);
    consecutiveCorrect = 0;
    advanced = true;
    reset = false;
    dueAt =
      stage >= MASTERY_STAGE
        ? null
        : addUtcDays(now, REVIEW_INTERVAL_DAYS[stage - 1]);
  }

  const status = reset
    ? "reset"
    : advanced
      ? "advanced"
      : consecutiveCorrect !== current.consecutiveCorrect
        ? "progress"
        : "unchanged";

  return {
    conceptKey: current.conceptKey,
    label: current.label,
    previousStage,
    stage,
    consecutiveCorrect,
    dueAt,
    lastReviewedAt: now,
    mastered: stage >= MASTERY_STAGE,
    status,
  };
}

export type SubmissionQuestion = {
  id: string;
  verdict: string | null;
  reviewConceptKey: string | null;
};

export function playableReviewQuestions<T extends SubmissionQuestion>(
  questions: T[]
): T[] {
  const eligible = questions.filter(
    (q) =>
      q.reviewConceptKey &&
      (q.verdict === "pass" || q.verdict === "repaired")
  );
  const counts = new Map<string, number>();
  for (const question of eligible) {
    const key = question.reviewConceptKey as string;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const complete = new Set(
    [...counts.entries()]
      .filter(([, count]) => count === 2)
      .map(([key]) => key)
  );
  return eligible.filter((q) => complete.has(q.reviewConceptKey as string));
}

export function validateReviewSubmission(
  questions: SubmissionQuestion[],
  submittedIds: string[]
): { ok: true; playableIds: string[] } | { ok: false; reason: string } {
  const playableIds = playableReviewQuestions(questions).map((q) => q.id);
  if (playableIds.length === 0) {
    return { ok: false, reason: "No complete verified concept pair is playable." };
  }
  const submitted = new Set(submittedIds);
  if (submitted.size !== submittedIds.length) {
    return { ok: false, reason: "Duplicate review answers are not allowed." };
  }
  if (
    submitted.size !== playableIds.length ||
    playableIds.some((id) => !submitted.has(id))
  ) {
    return {
      ok: false,
      reason: "Every playable review question must be answered exactly once.",
    };
  }
  return { ok: true, playableIds };
}
