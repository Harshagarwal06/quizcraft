-- AlterTable: Quiz — distinguish normal quizzes from generated mastery reviews.
ALTER TABLE "Quiz" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "Quiz" ADD COLUMN "sourceQuizId" TEXT;

-- AlterTable: Question — stable link from a generated review question to mastery state.
ALTER TABLE "Question" ADD COLUMN "reviewConceptKey" TEXT;

-- CreateTable: per-user, per-source-quiz concept scheduling state.
CREATE TABLE "ConceptReview" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "sourceQuizId" TEXT NOT NULL,
  "conceptKey" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "stage" INTEGER NOT NULL DEFAULT 0,
  "consecutiveCorrect" INTEGER NOT NULL DEFAULT 0,
  "dueAt" DATETIME,
  "lastReviewedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ConceptReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConceptReview_sourceQuizId_fkey" FOREIGN KEY ("sourceQuizId") REFERENCES "Quiz" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ConceptReview_userId_sourceQuizId_conceptKey_key"
  ON "ConceptReview"("userId", "sourceQuizId", "conceptKey");
CREATE INDEX "ConceptReview_userId_dueAt_idx"
  ON "ConceptReview"("userId", "dueAt");
