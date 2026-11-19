import { formRefusal } from './answer-bounds';

/**
 * The 400 refusing a form whose end (`closedAt`) is not after its opening (`opensAt`): a window that
 * never admits an answer. Worded by the client.
 */
export const FORM_CLOSE_BEFORE_OPEN = 'FORM_CLOSE_BEFORE_OPEN';

/**
 * The 400 refusing "Clore le formulaire" on a form whose opening is still to come (lead, 2026-11-16,
 * reversible): an end written NOW would fall before that opening, a window `assertWindowOrdered`
 * refuses at the next edit, so the manager could no longer publish one without first undoing a date
 * they never typed. Such a form takes no answer yet; its opening is what to move or clear.
 */
export const FORM_CLOSE_NOT_OPEN_YET = 'FORM_CLOSE_NOT_OPEN_YET';

/**
 * Refuses (400, `FORM_CLOSE_BEFORE_OPEN`) an end that does not fall after the opening. Either bound
 * absent is no window to order, so nothing is refused. Judged on the values a save WILL store, never
 * on what the request merely carried.
 */
export function assertWindowOrdered(
  opensAt: Date | null | undefined,
  closedAt: Date | null | undefined
): void {
  if (!opensAt || !closedAt) return;
  if (new Date(closedAt).getTime() > new Date(opensAt).getTime()) return;
  throw formRefusal(FORM_CLOSE_BEFORE_OPEN, 'The closing date must be after the opening date.');
}

/** Refuses (400, `FORM_CLOSE_NOT_OPEN_YET`) closing at `now` a form whose opening is after it. */
export function assertMayCloseAt(opensAt: Date | null | undefined, now: Date): void {
  if (!opensAt || new Date(opensAt).getTime() <= now.getTime()) return;
  throw formRefusal(
    FORM_CLOSE_NOT_OPEN_YET,
    'This form has not opened yet: move or clear its opening instead of closing it.'
  );
}

/** What a form's window says now: it takes answers, it opens later, or its end has passed. */
export const FORM_WINDOW_OPEN = 'open';
export const FORM_WINDOW_NOT_YET = 'not-yet';
export const FORM_WINDOW_CLOSED = 'closed';
export type FormWindowState =
  | typeof FORM_WINDOW_OPEN
  | typeof FORM_WINDOW_NOT_YET
  | typeof FORM_WINDOW_CLOSED;

/**
 * THE rule that says whether a form takes answers, judged on THE SERVER's clock: before the opening
 * it is `not-yet`, from the end instant on (the manager's close or a date that came) it is `closed`,
 * else `open`. Every refusal (`assertFormOpen`) and every read (`windowState` on the list, the
 * single read, the public read and the close answer) takes its answer from here, so a client never
 * compares a stored timestamp with its OWN clock - a phone behind the server would read a
 * just-closed form open (read on the Mi 9T, 2026-11-17).
 */
export function formWindowState(
  form: { opensAt?: Date | string | null; closedAt?: Date | string | null },
  now: Date = new Date()
): FormWindowState {
  if (form.opensAt && new Date(form.opensAt) > now) return FORM_WINDOW_NOT_YET;
  if (form.closedAt && new Date(form.closedAt) <= now) return FORM_WINDOW_CLOSED;
  return FORM_WINDOW_OPEN;
}
