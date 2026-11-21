/**
 * A RESPONDENT ALWAYS SEES THEIR OWN ANSWER, READ-ONLY (owner, 2026-11-21): "je voudrais pouvoir
 * voir ma reponse, meme si l'editeur m'interdit de la modifier" - `docs/wiki/frontend/modules/forms.md`,
 * "A respondent sees their own answer".
 *
 * Only a NAMED form has one to give back: the server's rows of this account
 * (`checkSubmission(..., { withAnswers })`, `myAnswers`), each with the questions that fixed its
 * price. An ANONYMOUS form's rows name nobody (principle 1): the server serves none, and no copy is
 * kept on the device either (owner, 2026-11-21, "Attendre la discussion": the copy will travel
 * through the planned conversation with oneself) - the page says "already answered" instead.
 */
import type { EditableAnswer } from './api';
import { Log } from '$lib/utils/Log';

/** One answer of the respondent, as the page draws it read-only. */
export interface OwnAnswer {
  id: string;
  createdAt: string;
  answers: Record<string, unknown>;
  /** The questions that fixed the price: drawn with the lock line. */
  lockedItemIds: string[];
}

/**
 * The respondent's own answers as served, or `null` when the estate does not serve them (older than
 * `myAnswers`: the page then draws what it drew before).
 */
export function ownAnswersOf(served: readonly EditableAnswer[] | undefined): OwnAnswer[] | null {
  if (!served) {
    Log.d('FormView', 'own answers not served by this estate (older than myAnswers)');
    return null;
  }
  return served.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    answers: row.answers,
    lockedItemIds: row.lockedItemIds ?? [],
  }));
}

/**
 * The answer a SINGLE-answer form draws once answered: the row the check names (`submissionId`, the
 * one it counts), else the newest. `null` when there is none to draw.
 */
export function shownOwnAnswer(
  own: readonly OwnAnswer[],
  submissionId: string | undefined
): OwnAnswer | null {
  return own.find((a) => a.id === submissionId) ?? own[0] ?? null;
}
