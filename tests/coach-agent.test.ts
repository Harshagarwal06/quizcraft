import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCoachCandidates,
  conceptPriorityScore,
  smoothedWeakness,
} from "../lib/coach/policy";
import {
  COACH_TOOL_ALLOWLIST,
  isAllowedCoachTool,
} from "../lib/coach/types";
import { actionConfirmationDisposition } from "../lib/coach/executor";
import { sourceQuestionHasLexicalSupport } from "../lib/coach/chat";
import { selectRequestedDueConcepts } from "../lib/mastery";

const NOW = new Date("2026-06-20T12:00:00.000Z");
const EXAM = new Date("2026-07-20T12:00:00.000Z");

test("coach weakness uses the smoothed error formula", () => {
  assert.equal(smoothedWeakness(0, 0), 0.5);
  assert.equal(smoothedWeakness(3, 4), 4 / 6);
});

test("due mastery review outranks lessons and quizzes", () => {
  const candidates = buildCoachCandidates({
    now: NOW,
    examDate: EXAM,
    sourceCount: 1,
    dueReviews: [
      {
        sourceQuizId: "quiz-1",
        sourceDocumentId: "source-1",
        quizTitle: "Biology",
        concepts: [
          { conceptKey: "osmosis", label: "Osmosis", stage: 0 },
        ],
      },
    ],
    concepts: [
      {
        conceptKey: "mitosis",
        label: "Mitosis",
        importance: 1,
        answered: 0,
        incorrect: 0,
        lastAnsweredAt: null,
        lastIncorrectAt: null,
        lastLessonAt: null,
        sourceDocumentId: "source-1",
        sourceQuizId: "quiz-1",
      },
    ],
  });
  assert.equal(candidates[0].type, "review");
  assert.ok(candidates[0].score > candidates[1].score);
});

test("recently missed concepts receive a lesson before a mixed quiz", () => {
  const candidates = buildCoachCandidates({
    now: NOW,
    examDate: EXAM,
    sourceCount: 1,
    dueReviews: [],
    concepts: [
      {
        conceptKey: "osmosis",
        label: "Osmosis",
        importance: 0.8,
        answered: 4,
        incorrect: 3,
        lastAnsweredAt: new Date("2026-06-20T10:00:00.000Z"),
        lastIncorrectAt: new Date("2026-06-20T10:00:00.000Z"),
        lastLessonAt: null,
        sourceDocumentId: "source-1",
        sourceQuizId: "quiz-1",
      },
    ],
  });
  assert.equal(candidates[0].type, "lesson");
  assert.equal(candidates.at(-1)?.type, "quiz");
});

test("concept ranking combines weakness importance recency and urgency", () => {
  const weak = conceptPriorityScore(
    {
      conceptKey: "weak",
      label: "Weak",
      importance: 1,
      answered: 4,
      incorrect: 4,
      lastAnsweredAt: new Date("2026-06-01T12:00:00.000Z"),
      lastIncorrectAt: NOW,
      lastLessonAt: null,
      sourceDocumentId: "source",
      sourceQuizId: "quiz",
    },
    EXAM,
    NOW
  );
  const strong = conceptPriorityScore(
    {
      conceptKey: "strong",
      label: "Strong",
      importance: 0.4,
      answered: 12,
      incorrect: 0,
      lastAnsweredAt: NOW,
      lastIncorrectAt: null,
      lastLessonAt: null,
      sourceDocumentId: "source",
      sourceQuizId: "quiz",
    },
    EXAM,
    NOW
  );
  assert.ok(weak > strong);
});

test("coach tools are restricted to the explicit allowlist", () => {
  assert.ok(COACH_TOOL_ALLOWLIST.every(isAllowedCoachTool));
  assert.equal(isAllowedCoachTool("fetch_arbitrary_url"), false);
  assert.equal(isAllowedCoachTool("run_recursive_agent"), false);
});

test("confirmation is idempotent and rejects stale actions", () => {
  assert.equal(
    actionConfirmationDisposition({
      status: "ready",
      actionVersion: 2,
      planVersion: 2,
    }),
    "ready"
  );
  assert.equal(
    actionConfirmationDisposition({
      status: "preparing",
      actionVersion: 2,
      planVersion: 2,
    }),
    "busy"
  );
  assert.equal(
    actionConfirmationDisposition({
      status: "proposed",
      actionVersion: 1,
      planVersion: 2,
    }),
    "stale"
  );
  assert.equal(
    actionConfirmationDisposition({
      status: "proposed",
      actionVersion: 2,
      planVersion: 2,
    }),
    "confirmable"
  );
});

test("targeted reviews accept only unique currently due concepts", () => {
  const concepts = [
    {
      conceptKey: "due",
      label: "Due",
      stage: 0,
      consecutiveCorrect: 0,
      dueAt: NOW,
    },
    {
      conceptKey: "future",
      label: "Future",
      stage: 0,
      consecutiveCorrect: 0,
      dueAt: new Date("2026-06-21T12:00:00.000Z"),
    },
  ];
  assert.equal(
    selectRequestedDueConcepts(concepts, NOW, ["due"]).ok,
    true
  );
  assert.equal(
    selectRequestedDueConcepts(concepts, NOW, ["future"]).ok,
    false
  );
  assert.equal(
    selectRequestedDueConcepts(concepts, NOW, ["due", "due"]).ok,
    false
  );
});

test("off-source chat questions cannot pass on generic conjunctions", () => {
  const source =
    "The plasma membrane is a phospholipid bilayer. Osmosis moves water across a selectively permeable membrane.";
  assert.equal(
    sourceQuestionHasLexicalSupport(
      "Explain quantum chromodynamics and gluon confinement",
      [source]
    ),
    false
  );
  assert.equal(
    sourceQuestionHasLexicalSupport("How does the plasma membrane work?", [
      source,
    ]),
    true
  );
  assert.equal(
    sourceQuestionHasLexicalSupport("What is osmosis?", [source]),
    true
  );
});
