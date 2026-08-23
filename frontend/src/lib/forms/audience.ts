import type { AudienceCondition } from './api';

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
