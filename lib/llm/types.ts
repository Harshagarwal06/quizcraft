import { z } from "zod";

export const optionSchema = z.object({
  id: z.enum(["A", "B", "C", "D"]),
  text: z.string(),
});

export const generatedQuestionSchema = z.object({
  blueprintItemId: z.string().optional(),
  stem: z.string(),
  options: z.array(optionSchema).length(4),
  correctOptionId: z.enum(["A", "B", "C", "D"]),
  explanation: z.string(),
  optionExplanations: z
    .object({
      A: z.string(),
      B: z.string(),
      C: z.string(),
      D: z.string(),
    })
    .optional(),
  difficulty: z.enum(["easy", "medium", "hard"]),
  topic: z.string(),
  evidence: z
    .array(
      z.object({
        chunkId: z.string(),
        quote: z.string(),
      })
    )
    .min(1)
    .max(2)
    .optional(),
});

export const generatedQuizSchema = z.object({
  title: z.string(),
  questions: z.array(generatedQuestionSchema).min(1),
});

export type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;
export type GeneratedQuiz = z.infer<typeof generatedQuizSchema>;

export interface ReviewConceptInput {
  key: string;
  label: string;
  recentStems: string[];
}

export interface GenerationInput {
  sourceText: string;
  userPrompt?: string;
  questionCount: number;
  seed: number;
  review?: {
    concepts: ReviewConceptInput[];
  };
}

export interface QuizGenerator {
  generate(input: GenerationInput): Promise<GeneratedQuiz>;
}
