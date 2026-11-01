/**
 * The question types a form or a booking space may store, mirrored from the frontend's canonical
 * list `frontend/src/lib/forms/questionTypes.ts` (`QUESTION_TYPES`). The two lists cannot share a
 * module across the frontend/backend package boundary, so this is a deliberate copy and the link is
 * this comment plus the drift test `form.dto.spec.ts`, which reads that source and fails when the
 * two sets differ.
 *
 * The repo's usual duplicate-list gate `declared-duplicates.mjs` cannot cover this pair: the frontend
 * file imports Lucide icons and Paraglide messages, so it cannot be required or parsed by that tool,
 * which is why the drift test reads it with `readFileSync` and a regex instead.
 *
 * `single` is intentionally ABSENT: it is a reader-only back-compat alias of `dropdown` that
 * `FormQuestion.svelte` still renders for old rows, but the builder never writes it and no stored
 * form uses it, so it is not accepted on a write.
 */
export const SUPPORTED_QUESTION_TYPES = [
  'short_text',
  'long_text',
  'single_choice',
  'multiple_choice',
  'dropdown',
  'linear_scale',
  'matrix_single',
  'matrix_multiple',
  'file',
] as const;

/** One of the question types a write may carry. */
export type SupportedQuestionType = (typeof SUPPORTED_QUESTION_TYPES)[number];
