import { prisma } from "@/lib/db";

export async function recordGenerationTrace(input: {
  quizId?: string;
  stage: string;
  batchIndex?: number;
  provider?: string;
  model?: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  questionCount?: number;
  retryCount?: number;
  status: "success" | "failed";
  errorCode?: string;
}): Promise<void> {
  await prisma.generationTrace
    .create({
      data: {
        quizId: input.quizId,
        stage: input.stage,
        batchIndex: input.batchIndex,
        provider: input.provider,
        model: input.model,
        durationMs: input.durationMs,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheTokens: input.cacheTokens,
        questionCount: input.questionCount,
        retryCount: input.retryCount ?? 0,
        status: input.status,
        errorCode: input.errorCode,
      },
    })
    .catch((error) => {
      console.warn("[trace] failed to persist generation trace:", error);
    });
}
