// Idempotent schema DDL, embedded so the deployed app can self-provision its
// database (e.g. a fresh Turso instance) without a separate migration step.
// Mirrors prisma/migrations/*/migration.sql with IF NOT EXISTS guards.
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" DATETIME,
    "image" TEXT,
    "password" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" DATETIME NOT NULL,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" DATETIME NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "Quiz" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceSummary" TEXT,
    "questionCount" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purpose" TEXT NOT NULL DEFAULT 'standard',
    "sourceQuizId" TEXT,
    "groundingText" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'pending',
    "verifiedAt" DATETIME,
    "verifierModel" TEXT,
    "verificationSummary" TEXT,
    "generatorModel" TEXT,
    "generatorPromptHash" TEXT,
    "verifierPromptHash" TEXT,
    CONSTRAINT "Quiz_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "Question" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quizId" TEXT NOT NULL,
    "stem" TEXT NOT NULL,
    "options" TEXT NOT NULL,
    "correctOption" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "reviewConceptKey" TEXT,
    "verdict" TEXT,
    "verificationDetail" TEXT,
    CONSTRAINT "Question_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "Attempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quizId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "score" INTEGER,
    "totalQuestions" INTEGER NOT NULL,
    CONSTRAINT "Attempt_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Attempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "AnswerRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "selectedOption" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "timeMs" INTEGER,
    CONSTRAINT "AnswerRecord_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AnswerRecord_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "ConceptReview" (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Session_sessionToken_key" ON "Session"("sessionToken")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "VerificationToken_token_key" ON "VerificationToken"("token")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ConceptReview_userId_sourceQuizId_conceptKey_key" ON "ConceptReview"("userId", "sourceQuizId", "conceptKey")`,
  `CREATE INDEX IF NOT EXISTS "ConceptReview_userId_dueAt_idx" ON "ConceptReview"("userId", "dueAt")`,
];

// Columns added after the initial tables shipped. SQLite has no
// "ADD COLUMN IF NOT EXISTS", so these run individually and the "duplicate
// column name" error is swallowed (see ensureSchema in lib/db.ts). This lets an
// already-provisioned DB (e.g. a live Turso instance) self-upgrade on first use.
export const ADDITIVE_COLUMNS: string[] = [
  `ALTER TABLE "Quiz" ADD COLUMN "groundingText" TEXT`,
  `ALTER TABLE "Quiz" ADD COLUMN "verificationStatus" TEXT NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE "Quiz" ADD COLUMN "verifiedAt" DATETIME`,
  `ALTER TABLE "Quiz" ADD COLUMN "verifierModel" TEXT`,
  `ALTER TABLE "Quiz" ADD COLUMN "verificationSummary" TEXT`,
  `ALTER TABLE "Question" ADD COLUMN "verdict" TEXT`,
  `ALTER TABLE "Question" ADD COLUMN "verificationDetail" TEXT`,
  `ALTER TABLE "Quiz" ADD COLUMN "generatorModel" TEXT`,
  `ALTER TABLE "Quiz" ADD COLUMN "generatorPromptHash" TEXT`,
  `ALTER TABLE "Quiz" ADD COLUMN "verifierPromptHash" TEXT`,
  `ALTER TABLE "Quiz" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'standard'`,
  `ALTER TABLE "Quiz" ADD COLUMN "sourceQuizId" TEXT`,
  `ALTER TABLE "Question" ADD COLUMN "reviewConceptKey" TEXT`,
];
