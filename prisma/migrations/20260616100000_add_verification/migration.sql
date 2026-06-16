-- AlterTable: Quiz — quality-engine (verification) fields
ALTER TABLE "Quiz" ADD COLUMN "groundingText" TEXT;
ALTER TABLE "Quiz" ADD COLUMN "verificationStatus" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "Quiz" ADD COLUMN "verifiedAt" DATETIME;
ALTER TABLE "Quiz" ADD COLUMN "verifierModel" TEXT;
ALTER TABLE "Quiz" ADD COLUMN "verificationSummary" TEXT;

-- AlterTable: Question — quality-engine (verification) fields
ALTER TABLE "Question" ADD COLUMN "verdict" TEXT;
ALTER TABLE "Question" ADD COLUMN "verificationDetail" TEXT;
