import { GeneratedQuiz } from "./types";

const IDS = ["A", "B", "C", "D"] as const;

/**
 * Randomizes the position of each question's options and remaps the correct
 * answer accordingly. LLMs tend to cluster the correct answer in the first
 * couple of slots (A/B), which makes quizzes predictable; shuffling here makes
 * the correct option's letter uniform and independent of the model's bias.
 *
 * Tracks the correct answer by its original index (not its text) so it stays
 * correct even if two options happen to share the same text.
 */
export function shuffleQuizOptions(quiz: GeneratedQuiz): GeneratedQuiz {
  return {
    ...quiz,
    questions: quiz.questions.map((q) => {
      const correctIdx = q.options.findIndex((o) => o.id === q.correctOptionId);

      // Fisher–Yates over an index permutation of the original options.
      const perm = q.options.map((_, i) => i);
      for (let i = perm.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }

      const options = perm.map((origIdx, newIdx) => ({
        id: IDS[newIdx],
        text: q.options[origIdx].text,
      }));
      const newCorrectPos = perm.indexOf(correctIdx);
      const correctOptionId = newCorrectPos >= 0 ? IDS[newCorrectPos] : q.correctOptionId;

      return { ...q, options, correctOptionId };
    }),
  };
}
