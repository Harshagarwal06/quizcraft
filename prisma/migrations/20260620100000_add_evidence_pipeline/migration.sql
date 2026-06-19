ALTER TABLE "Quiz" ADD COLUMN "sourceDocumentId" TEXT;
ALTER TABLE "Quiz" ADD COLUMN "generationStatus" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "Quiz" ADD COLUMN "targetQuestionCount" INTEGER;
ALTER TABLE "Quiz" ADD COLUMN "firstBatchReadyAt" DATETIME;
ALTER TABLE "Quiz" ADD COLUMN "generationError" TEXT;

ALTER TABLE "Question" ADD COLUMN "blueprintItemId" TEXT;
ALTER TABLE "Question" ADD COLUMN "optionExplanations" TEXT;
ALTER TABLE "Question" ADD COLUMN "evidenceStatus" TEXT NOT NULL DEFAULT 'missing';

CREATE TABLE "SourceDocument" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "fullText" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "originUrl" TEXT,
  "extractionMetadata" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "SourceDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SourceChunk" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sourceDocumentId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "pageStart" INTEGER,
  "pageEnd" INTEGER,
  "section" TEXT,
  "text" TEXT NOT NULL,
  "normalizedText" TEXT NOT NULL,
  "tokenCount" INTEGER NOT NULL,
  CONSTRAINT "SourceChunk_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SourceReference" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sourceDocumentId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "authority" TEXT NOT NULL,
  CONSTRAINT "SourceReference_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ChunkReference" (
  "sourceChunkId" TEXT NOT NULL,
  "sourceReferenceId" TEXT NOT NULL,
  PRIMARY KEY ("sourceChunkId", "sourceReferenceId"),
  CONSTRAINT "ChunkReference_sourceChunkId_fkey" FOREIGN KEY ("sourceChunkId") REFERENCES "SourceChunk" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ChunkReference_sourceReferenceId_fkey" FOREIGN KEY ("sourceReferenceId") REFERENCES "SourceReference" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "QuizBlueprintItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "quizId" TEXT NOT NULL,
  "slot" INTEGER NOT NULL,
  "conceptKey" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "objective" TEXT NOT NULL,
  "difficulty" TEXT NOT NULL,
  "skillType" TEXT NOT NULL,
  "retrievalQuery" TEXT NOT NULL,
  "requiredFacts" TEXT NOT NULL,
  "seedChunkIds" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "failureCode" TEXT,
  "batchIndex" INTEGER NOT NULL,
  CONSTRAINT "QuizBlueprintItem_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "QuizGenerationBatch" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "quizId" TEXT NOT NULL,
  "batchIndex" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "startedAt" DATETIME,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "QuizGenerationBatch_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "QuestionEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "questionId" TEXT NOT NULL,
  "sourceChunkId" TEXT NOT NULL,
  "quote" TEXT NOT NULL,
  "displayOrder" INTEGER NOT NULL,
  CONSTRAINT "QuestionEvidence_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "QuestionEvidence_sourceChunkId_fkey" FOREIGN KEY ("sourceChunkId") REFERENCES "SourceChunk" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "GenerationTrace" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "quizId" TEXT,
  "stage" TEXT NOT NULL,
  "batchIndex" INTEGER,
  "provider" TEXT,
  "model" TEXT,
  "durationMs" INTEGER NOT NULL,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "cacheTokens" INTEGER,
  "questionCount" INTEGER,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL,
  "errorCode" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GenerationTrace_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SourceDocument_userId_contentHash_key" ON "SourceDocument"("userId", "contentHash");
CREATE UNIQUE INDEX "SourceChunk_sourceDocumentId_ordinal_key" ON "SourceChunk"("sourceDocumentId", "ordinal");
CREATE INDEX "SourceChunk_sourceDocumentId_idx" ON "SourceChunk"("sourceDocumentId");
CREATE UNIQUE INDEX "SourceReference_sourceDocumentId_url_key" ON "SourceReference"("sourceDocumentId", "url");
CREATE UNIQUE INDEX "QuizBlueprintItem_quizId_slot_key" ON "QuizBlueprintItem"("quizId", "slot");
CREATE INDEX "QuizBlueprintItem_quizId_batchIndex_idx" ON "QuizBlueprintItem"("quizId", "batchIndex");
CREATE UNIQUE INDEX "QuizGenerationBatch_quizId_batchIndex_key" ON "QuizGenerationBatch"("quizId", "batchIndex");
CREATE INDEX "QuizGenerationBatch_quizId_status_idx" ON "QuizGenerationBatch"("quizId", "status");
CREATE UNIQUE INDEX "QuestionEvidence_questionId_displayOrder_key" ON "QuestionEvidence"("questionId", "displayOrder");
CREATE UNIQUE INDEX "Question_blueprintItemId_key" ON "Question"("blueprintItemId");
CREATE INDEX "GenerationTrace_quizId_stage_idx" ON "GenerationTrace"("quizId", "stage");
CREATE INDEX "GenerationTrace_stage_createdAt_idx" ON "GenerationTrace"("stage", "createdAt");
