-- AlterTable: Quiz — provenance (attribute quality to a model + prompt version)
ALTER TABLE "Quiz" ADD COLUMN "generatorModel" TEXT;
ALTER TABLE "Quiz" ADD COLUMN "generatorPromptHash" TEXT;
ALTER TABLE "Quiz" ADD COLUMN "verifierPromptHash" TEXT;
