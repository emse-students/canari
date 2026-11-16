import type { Form } from './api';

/**
 * The 400 refusing a form whose end is not after its opening (`form-window.ts` on the server). The
 * editor says it first (`formWindowInvalid`); the code is the server's answer to a client that did not.
 */
export const FORM_CLOSE_BEFORE_OPEN = 'FORM_CLOSE_BEFORE_OPEN';

/**
 * Whether a form's window is impossible: both bounds typed (`datetime-local` strings, `''` for none)
 * and the end NOT after the opening. One bound alone is never invalid.
 */
export function formWindowInvalid(opensAt: string, closedAt: string): boolean {
  if (!opensAt || !closedAt) return false;
  const opens = new Date(opensAt).getTime();
  const closes = new Date(closedAt).getTime();
  if (Number.isNaN(opens) || Number.isNaN(closes)) return false;
  return closes <= opens;
}

/**
 * Whether a manager's list row shows "Ferme": the form has an end that has passed (the manager's
 * close, or a date that came). An end still to come is a scheduled close, not a closed form.
 */
export function isClosedForm(
  form: Pick<Form, 'closedAt'> | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!form?.closedAt) return false;
  const end = Date.parse(form.closedAt);
  return !Number.isNaN(end) && end <= nowMs;
}
