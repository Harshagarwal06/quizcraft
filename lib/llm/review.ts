import { GeneratedQuiz, ReviewConceptInput } from "./types";

function normalizeStem(stem: string): string {
  return stem
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function validateReviewQuiz(
  quiz: GeneratedQuiz,
  concepts: ReviewConceptInput[]
): GeneratedQuiz {
  const expectedCount = concepts.length * 2;
  if (quiz.questions.length !== expectedCount) {
    throw new Error(
      `Review generation returned ${quiz.questions.length} questions; expected ${expectedCount}`
    );
  }

  const targets = new Map(concepts.map((concept) => [concept.label, concept]));
  const seen = new Set<string>();
  const previous = new Set(
    concepts.flatMap((concept) => concept.recentStems.map(normalizeStem))
  );
  const counts = new Map<string, { medium: number; hard: number }>();

  for (const question of quiz.questions) {
    if (!targets.has(question.topic)) {
      throw new Error(`Review question used off-target topic "${question.topic}"`);
    }
    if (question.difficulty !== "medium" && question.difficulty !== "hard") {
      throw new Error("Review questions must be medium or hard");
    }

    const stem = normalizeStem(question.stem);
    if (!stem || seen.has(stem) || previous.has(stem)) {
      throw new Error("Review generation repeated an existing question stem");
    }
    seen.add(stem);

    const topicCounts = counts.get(question.topic) ?? { medium: 0, hard: 0 };
    topicCounts[question.difficulty] += 1;
    counts.set(question.topic, topicCounts);
  }

  for (const concept of concepts) {
    const topicCounts = counts.get(concept.label);
    if (
      !topicCounts ||
      topicCounts.medium !== 1 ||
      topicCounts.hard !== 1
    ) {
      throw new Error(
        `Review topic "${concept.label}" must contain one medium and one hard question`
      );
    }
  }

  return quiz;
}
