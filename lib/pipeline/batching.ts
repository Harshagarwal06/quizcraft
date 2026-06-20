// Batch sizing for evidence-backed quiz generation.
//
// Time-to-first-question is the priority: the player can only show question 1
// once a whole batch has generated AND verified (and survived any repair round).
// So the FIRST batch is intentionally tiny — a single question — to surface Q1
// as fast as possible, while the remaining questions fill in via larger
// background batches the player prepares two-at-a-time.
//
// This module is the single source of truth for the slot → batchIndex mapping
// and the batch count. Both the blueprint (which stamps each item's batchIndex)
// and the pipeline (which creates one QuizGenerationBatch per batch) derive from
// here so they can never disagree.
export const FIRST_BATCH_SIZE = 1;
export const REST_BATCH_SIZE = 3;

/** Which batch a 0-based blueprint slot belongs to. */
export function batchIndexForSlot(slot: number): number {
  if (slot < FIRST_BATCH_SIZE) return 0;
  return 1 + Math.floor((slot - FIRST_BATCH_SIZE) / REST_BATCH_SIZE);
}

/** How many batches a quiz of `count` questions is split into. */
export function batchCountForQuestions(count: number): number {
  if (count <= 0) return 0;
  if (count <= FIRST_BATCH_SIZE) return 1;
  return 1 + Math.ceil((count - FIRST_BATCH_SIZE) / REST_BATCH_SIZE);
}
