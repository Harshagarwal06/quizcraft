import test from "node:test";
import assert from "node:assert/strict";
import { validateReviewQuiz } from "../lib/llm/review";
import type { GeneratedQuiz, ReviewConceptInput } from "../lib/llm/types";

const concepts: ReviewConceptInput[] = [
  {
    key: "calvin-cycle",
    label: "Calvin Cycle",
    recentStems: ["Where does the Calvin cycle occur?"],
  },
  {
    key: "chlorophyll",
    label: "Chlorophyll",
    recentStems: [],
  },
];

function question(
  stem: string,
  topic: string,
  difficulty: "medium" | "hard"
): GeneratedQuiz["questions"][number] {
  return {
    stem,
    topic,
    difficulty,
    correctOptionId: "A",
    explanation: "Because the source supports option A.",
    options: [
      { id: "A", text: "Correct" },
      { id: "B", text: "Wrong one" },
      { id: "C", text: "Wrong two" },
      { id: "D", text: "Wrong three" },
    ],
  };
}

function validQuiz(): GeneratedQuiz {
  return {
    title: "Targeted Review",
    questions: [
      question("What role does carbon fixation play?", "Calvin Cycle", "medium"),
      question("How would limited ATP affect sugar production?", "Calvin Cycle", "hard"),
      question("What light does chlorophyll absorb most?", "Chlorophyll", "medium"),
      question("How would pigment loss affect photosynthesis?", "Chlorophyll", "hard"),
    ],
  };
}

test("accepts exact coverage with one medium and one hard question per concept", () => {
  assert.equal(validateReviewQuiz(validQuiz(), concepts).questions.length, 4);
});

test("rejects off-target topics, repeated stems, and incomplete difficulty coverage", () => {
  const offTarget = validQuiz();
  offTarget.questions[0].topic = "Carbon Reactions";
  assert.throws(() => validateReviewQuiz(offTarget, concepts), /off-target/);

  const repeated = validQuiz();
  repeated.questions[0].stem = "Where does the Calvin cycle occur?";
  assert.throws(() => validateReviewQuiz(repeated, concepts), /repeated/);

  const wrongDifficulty = validQuiz();
  wrongDifficulty.questions[1].difficulty = "medium";
  assert.throws(
    () => validateReviewQuiz(wrongDifficulty, concepts),
    /one medium and one hard/
  );
});
