import test from "node:test";
import assert from "node:assert/strict";
import {
  applyReviewAnswers,
  collectStandardMistakes,
  normalizeConceptKey,
  playableReviewQuestions,
  REVIEW_INTERVAL_DAYS,
  selectDueConcepts,
  validateReviewSubmission,
} from "../lib/mastery";

const NOW = new Date("2026-06-19T12:00:00.000Z");

test("normalizes equivalent topic labels and merges standard mistakes", () => {
  assert.equal(normalizeConceptKey("  Calvin  Cycle "), "calvin-cycle");
  assert.equal(normalizeConceptKey("Calvin-cycle"), "calvin-cycle");

  const mistakes = collectStandardMistakes([
    { topic: "Calvin Cycle", isCorrect: false },
    { topic: "calvin-cycle", isCorrect: false },
    { topic: "Chlorophyll", isCorrect: true },
  ]);
  assert.equal(mistakes.size, 1);
  assert.equal(mistakes.get("calvin-cycle"), "calvin-cycle");
});

test("selects at most three weakest and oldest due concepts", () => {
  const selected = selectDueConcepts(
    [
      {
        conceptKey: "later",
        label: "Later",
        stage: 0,
        consecutiveCorrect: 0,
        dueAt: new Date("2026-06-19T11:00:00.000Z"),
      },
      {
        conceptKey: "oldest",
        label: "Oldest",
        stage: 0,
        consecutiveCorrect: 0,
        dueAt: new Date("2026-06-18T11:00:00.000Z"),
      },
      {
        conceptKey: "stage-one",
        label: "Stage one",
        stage: 1,
        consecutiveCorrect: 0,
        dueAt: new Date("2026-06-17T11:00:00.000Z"),
      },
      {
        conceptKey: "future",
        label: "Future",
        stage: 0,
        consecutiveCorrect: 0,
        dueAt: new Date("2026-06-20T11:00:00.000Z"),
      },
      {
        conceptKey: "third",
        label: "Third",
        stage: 0,
        consecutiveCorrect: 0,
        dueAt: new Date("2026-06-19T10:00:00.000Z"),
      },
    ],
    NOW
  );
  assert.deepEqual(
    selected.map((concept) => concept.conceptKey),
    ["oldest", "third", "later"]
  );
});

for (let stage = 0; stage <= 4; stage += 1) {
  test(`two consecutive correct answers advance stage ${stage}`, () => {
    const result = applyReviewAnswers(
      {
        conceptKey: "topic",
        label: "Topic",
        stage,
        consecutiveCorrect: 0,
        dueAt: NOW,
      },
      [true, true],
      NOW
    );
    assert.equal(result.stage, stage + 1);
    assert.equal(result.status, "advanced");
    assert.equal(
      result.dueAt?.toISOString(),
      new Date(
        NOW.getTime() + REVIEW_INTERVAL_DAYS[stage] * 86_400_000
      ).toISOString()
    );
  });
}

test("passing the 30-day review marks a concept mastered", () => {
  const result = applyReviewAnswers(
    {
      conceptKey: "topic",
      label: "Topic",
      stage: 5,
      consecutiveCorrect: 0,
      dueAt: NOW,
    },
    [true, true],
    NOW
  );
  assert.equal(result.stage, 6);
  assert.equal(result.mastered, true);
  assert.equal(result.dueAt, null);
});

test("a wrong review answer resets mastery immediately", () => {
  const result = applyReviewAnswers(
    {
      conceptKey: "topic",
      label: "Topic",
      stage: 4,
      consecutiveCorrect: 1,
      dueAt: NOW,
    },
    [false, true],
    NOW
  );
  assert.equal(result.stage, 0);
  assert.equal(result.consecutiveCorrect, 1);
  assert.equal(result.status, "reset");
  assert.equal(result.dueAt?.toISOString(), NOW.toISOString());
});

test("allows at most one stage advancement per attempt", () => {
  const result = applyReviewAnswers(
    {
      conceptKey: "topic",
      label: "Topic",
      stage: 0,
      consecutiveCorrect: 0,
      dueAt: NOW,
    },
    [true, true, true, true],
    NOW
  );
  assert.equal(result.stage, 1);
});

test("only complete verified pairs are playable", () => {
  const questions = [
    { id: "a1", verdict: "pass", reviewConceptKey: "a" },
    { id: "a2", verdict: "repaired", reviewConceptKey: "a" },
    { id: "b1", verdict: "pass", reviewConceptKey: "b" },
    { id: "b2", verdict: "flagged", reviewConceptKey: "b" },
  ];
  assert.deepEqual(
    playableReviewQuestions(questions).map((question) => question.id),
    ["a1", "a2"]
  );
});

test("rejects partial, duplicate, and unverified review submissions", () => {
  const verified = [
    { id: "a1", verdict: "pass", reviewConceptKey: "a" },
    { id: "a2", verdict: "repaired", reviewConceptKey: "a" },
  ];
  assert.equal(validateReviewSubmission(verified, ["a1"]).ok, false);
  assert.equal(validateReviewSubmission(verified, ["a1", "a1"]).ok, false);
  assert.equal(
    validateReviewSubmission(
      [
        { id: "a1", verdict: null, reviewConceptKey: "a" },
        { id: "a2", verdict: null, reviewConceptKey: "a" },
      ],
      ["a1", "a2"]
    ).ok,
    false
  );
  assert.equal(validateReviewSubmission(verified, ["a1", "a2"]).ok, true);
});
