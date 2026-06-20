CREATE TABLE "StudyPlan" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "examTitle" TEXT NOT NULL,
  "examDate" DATETIME NOT NULL,
  "targetScore" INTEGER NOT NULL,
  "dailyMinutes" INTEGER NOT NULL,
  "availableDays" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "activeKey" TEXT,
  "stateVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "StudyPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "StudyPlanSource" (
  "studyPlanId" TEXT NOT NULL,
  "sourceDocumentId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("studyPlanId", "sourceDocumentId"),
  CONSTRAINT "StudyPlanSource_studyPlanId_fkey" FOREIGN KEY ("studyPlanId") REFERENCES "StudyPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StudyPlanSource_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "PlanConcept" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "studyPlanId" TEXT NOT NULL,
  "sourceDocumentId" TEXT NOT NULL,
  "sourceQuizId" TEXT,
  "conceptKey" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "importance" REAL NOT NULL DEFAULT 0.5,
  "objectives" TEXT NOT NULL,
  "seedChunkIds" TEXT NOT NULL,
  "proficiency" REAL NOT NULL DEFAULT 0,
  "lastActivityAt" DATETIME,
  "lastLessonAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "PlanConcept_studyPlanId_fkey" FOREIGN KEY ("studyPlanId") REFERENCES "StudyPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CoachThread" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "studyPlanId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "CoachThread_studyPlanId_fkey" FOREIGN KEY ("studyPlanId") REFERENCES "StudyPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CoachMessage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "threadId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "citations" TEXT,
  "pendingPlanUpdate" TEXT,
  "proposedActionId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CoachMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "CoachThread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CoachAction" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "studyPlanId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'proposed',
  "title" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "estimatedMinutes" INTEGER NOT NULL,
  "conceptKeys" TEXT NOT NULL,
  "sourceDocumentIds" TEXT NOT NULL,
  "payload" TEXT,
  "planStateVersion" INTEGER NOT NULL,
  "generatedQuizId" TEXT,
  "readyHref" TEXT,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "approvedAt" DATETIME,
  "startedAt" DATETIME,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "CoachAction_studyPlanId_fkey" FOREIGN KEY ("studyPlanId") REFERENCES "StudyPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CoachLesson" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "studyPlanId" TEXT NOT NULL,
  "actionId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "conceptKey" TEXT NOT NULL,
  "sections" TEXT NOT NULL,
  "misconception" TEXT NOT NULL,
  "workedExample" TEXT,
  "summary" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" DATETIME,
  CONSTRAINT "CoachLesson_studyPlanId_fkey" FOREIGN KEY ("studyPlanId") REFERENCES "StudyPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CoachLesson_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "CoachAction" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CoachLessonEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "lessonId" TEXT NOT NULL,
  "sourceChunkId" TEXT NOT NULL,
  "quote" TEXT NOT NULL,
  "displayOrder" INTEGER NOT NULL,
  CONSTRAINT "CoachLessonEvidence_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "CoachLesson" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CoachLessonEvidence_sourceChunkId_fkey" FOREIGN KEY ("sourceChunkId") REFERENCES "SourceChunk" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CoachRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "studyPlanId" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "candidateActions" TEXT NOT NULL,
  "selectedActionType" TEXT,
  "selectedActionId" TEXT,
  "provider" TEXT,
  "model" TEXT,
  "durationMs" INTEGER NOT NULL,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "status" TEXT NOT NULL,
  "policyRejected" BOOLEAN NOT NULL DEFAULT false,
  "errorCode" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CoachRun_studyPlanId_fkey" FOREIGN KEY ("studyPlanId") REFERENCES "StudyPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "StudyPlan_activeKey_key" ON "StudyPlan"("activeKey");
CREATE INDEX "StudyPlan_userId_status_idx" ON "StudyPlan"("userId", "status");
CREATE INDEX "StudyPlanSource_sourceDocumentId_idx" ON "StudyPlanSource"("sourceDocumentId");
CREATE UNIQUE INDEX "PlanConcept_studyPlanId_conceptKey_key" ON "PlanConcept"("studyPlanId", "conceptKey");
CREATE INDEX "PlanConcept_studyPlanId_sourceDocumentId_idx" ON "PlanConcept"("studyPlanId", "sourceDocumentId");
CREATE UNIQUE INDEX "CoachThread_studyPlanId_key" ON "CoachThread"("studyPlanId");
CREATE INDEX "CoachMessage_threadId_createdAt_idx" ON "CoachMessage"("threadId", "createdAt");
CREATE INDEX "CoachAction_studyPlanId_status_createdAt_idx" ON "CoachAction"("studyPlanId", "status", "createdAt");
CREATE UNIQUE INDEX "CoachLesson_actionId_key" ON "CoachLesson"("actionId");
CREATE INDEX "CoachLesson_studyPlanId_createdAt_idx" ON "CoachLesson"("studyPlanId", "createdAt");
CREATE UNIQUE INDEX "CoachLessonEvidence_lessonId_displayOrder_key" ON "CoachLessonEvidence"("lessonId", "displayOrder");
CREATE INDEX "CoachRun_studyPlanId_createdAt_idx" ON "CoachRun"("studyPlanId", "createdAt");
