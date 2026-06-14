-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" DATETIME,
    "image" TEXT,
    "password" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Account" (
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
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" DATETIME NOT NULL,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Quiz" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceSummary" TEXT,
    "questionCount" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Quiz_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quizId" TEXT NOT NULL,
    "stem" TEXT NOT NULL,
    "options" TEXT NOT NULL,
    "correctOption" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    CONSTRAINT "Question_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Attempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quizId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "score" INTEGER,
    "totalQuestions" INTEGER NOT NULL,
    CONSTRAINT "Attempt_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Attempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnswerRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "selectedOption" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "timeMs" INTEGER,
    CONSTRAINT "AnswerRecord_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AnswerRecord_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");
