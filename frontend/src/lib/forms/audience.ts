import type { AudienceCondition } from './api';

/**
 * Whether the cotisation criterion asks that the person HOLDS a tier (`cotisation`) or holds NONE
 * of them (`notCotisation`) - the creator's "detient" / "ne detient pas" (owner, 2026-10-30).
 */
export type CotisationMode = 'holds' | 'notHolds';

/** The condition key a mode is stored under. */
export function cotisationKey(mode: CotisationMode): 'cotisation' | 'notCotisation' {
  return mode === 'holds' ? 'cotisation' : 'notCotisation';
}

/**
 * The mode a condition is in. A stored criterion decides it; with none ticked yet, the mode the
 * creator last picked (`preferred`) holds, so choosing "ne detient pas" before a tier is kept.
 */
export function cotisationModeOf(
  condition: AudienceCondition | null | undefined,
  preferred: CotisationMode
): CotisationMode {
  if (condition?.notCotisation) return 'notHolds';
  if (condition?.cotisation) return 'holds';
  return preferred;
}

/**
 * The condition with its cotisation criterion moved under `mode`'s key, the tiers kept. The other
 * key is always removed: the server refuses a condition carrying both.
 */
export function withCotisationMode(
  condition: AudienceCondition,
  mode: CotisationMode
): AudienceCondition {
  const criterion = condition.cotisation ?? condition.notCotisation;
  const { cotisation: _held, notCotisation: _notHeld, ...rest } = condition;
  return criterion ? { ...rest, [cotisationKey(mode)]: criterion } : rest;
}

/**
 * The one thing an audience condition can be wrong about while it is being built.
 *
 * A condition with no criterion applies to everybody, so it restricts nothing and hides nothing -
 * the server refuses it outright, and it must never be sent: the refusal is a developer sentence
 * about a document, which is not what a manager should read for having flipped a switch and stopped.
 */

/** True when the switch is on but nothing has been ticked yet. */
export function isEmptyCondition(condition: AudienceCondition | null | undefined): boolean {
  return condition != null && Object.keys(condition).length === 0;
}

/**
 * The first empty condition on a form, if any: the form's own, or the label of a question carrying
 * one. Returns null when everything is either off or filled in.
 *
 * Both admin screens call this before saving, so the message is theirs and localized.
 */
export function firstEmptyCondition(
  submitCondition: AudienceCondition | null,
  items: { label?: string; showIf?: AudienceCondition | null }[]
): { scope: 'form' } | { scope: 'question'; label: string } | null {
  if (isEmptyCondition(submitCondition)) return { scope: 'form' };
  const question = items.find((item) => isEmptyCondition(item.showIf));
  return question ? { scope: 'question', label: question.label ?? '' } : null;
}
