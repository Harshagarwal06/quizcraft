import { z } from "zod";

export const optionSchema = z.object({
  id: z.enum(["A", "B", "C", "D"]),
  text: z.string(),
});

export const generatedQuestionSchema = z.object({
  stem: z.string(),
  options: z.array(optionSchema).length(4),
  correctOptionId: z.enum(["A", "B", "C", "D"]),
  explanation: z.string(),
  difficulty: z.enum(["easy", "medium", "hard"]),
  topic: z.string(),
});

export const generatedQuizSchema = z.object({
  title: z.string(),
  questions: z.array(generatedQuestionSchema).min(1),
});

export type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;
export type GeneratedQuiz = z.infer<typeof generatedQuizSchema>;

export interface GenerationInput {
  sourceText: string;
  userPrompt?: string;
  questionCount: number;
  seed: number;
}

export interface QuizGenerator {
  generate(input: GenerationInput): Promise<GeneratedQuiz>;
}
