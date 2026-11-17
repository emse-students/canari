import type { Form } from './api';

/**
 * The 400 refusing a form whose end is not after its opening (`form-window.ts` on the server). The
 * editor says it first (`formWindowInvalid`); the code is the server's answer to a client that did not.
 */
export const FORM_CLOSE_BEFORE_OPEN = 'FORM_CLOSE_BEFORE_OPEN';

/**
 * The 400 refusing "Clore le formulaire" on a form whose opening is still to come (`form-window.ts`
 * on the server, lead 2026-11-16): the list does not offer it (`opensLater`); the code is the
 * server's answer to a list read before the opening moved.
 */
export const FORM_CLOSE_NOT_OPEN_YET = 'FORM_CLOSE_NOT_OPEN_YET';

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
 * Whether a form's opening is still to come: it takes no answer yet, so the list offers no
 * "Clore le formulaire" (the server refuses it, `FORM_CLOSE_NOT_OPEN_YET`).
 */
export function opensLater(
  form: Pick<Form, 'opensAt'> | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!form?.opensAt) return false;
  const opens = Date.parse(form.opensAt);
  return !Number.isNaN(opens) && opens > nowMs;
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

/**
 * The `closedAt` a close ANSWER stores on a row. The answer means "closed now", but the server
 * stamped it with ITS clock: a few seconds ahead of this device's, `isClosedForm` would read the
 * form open until they caught up and the "Ferme" badge would wait for a re-entry of the list.
 * An end this clock has not reached is pulled back to now; one it has passed is kept as is.
 */
export function closedByAnswer(closedAt: string | null, nowMs: number = Date.now()): string | null {
  if (!closedAt) return null;
  const end = Date.parse(closedAt);
  return Number.isNaN(end) || end <= nowMs ? closedAt : new Date(nowMs).toISOString();
}
