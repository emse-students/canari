import { Log } from '$lib/utils/Log';
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
 * The 400 refusing "Fixer une date" with an instant that is not in the future (`form-window.ts` on
 * the server): a close is what "Fermer" is for.
 */
export const FORM_CLOSING_DATE_PAST = 'FORM_CLOSING_DATE_PAST';

/** The 409 refusing "Fixer une date" on a form closed, dated or unpublished meanwhile. */
export const FORM_CLOSING_DATE_NOT_OPEN = 'FORM_CLOSING_DATE_NOT_OPEN';

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
 * What a form's window says now, JUDGED BY THE SERVER (`windowState` on the list, the single read,
 * the public read and the close answer; `form-window.ts` there). The device never compares a stored
 * `opensAt` / `closedAt` with its own clock: a phone behind the server read a just-closed form open
 * (read on the Mi 9T, 2026-11-17). A server that predates the field sends none; the comparison is
 * then the fallback, and it says so ONCE at warn - reaching it means the server is older than this
 * client, which is a signal, not a path.
 */
export type FormWindowState = 'open' | 'not-yet' | 'closed';

type WindowFields = Pick<Form, 'opensAt' | 'closedAt' | 'windowState'>;

let warnedMissingState = false;

export function formWindowState(
  form: Partial<WindowFields> | null | undefined,
  nowMs: number = Date.now()
): FormWindowState {
  if (form?.windowState) return form.windowState;
  if (!form) return 'open';
  if (!warnedMissingState && (form.opensAt || form.closedAt)) {
    warnedMissingState = true;
    Log.w(
      'FormWindow',
      'the server sent no windowState on a form with a window: judging by the device clock'
    );
  }
  if (form.opensAt) {
    const opens = Date.parse(form.opensAt);
    if (!Number.isNaN(opens) && opens > nowMs) return 'not-yet';
  }
  if (form.closedAt) {
    // From the end instant on, as the server's rule is: a close writes the end as `now`.
    const end = Date.parse(form.closedAt);
    if (!Number.isNaN(end) && end <= nowMs) return 'closed';
  }
  return 'open';
}

/**
 * The state a TYPED refusal of an answer proves (`FORM_CLOSED`, `FORM_NOT_OPEN_YET`), or null for
 * any other code. The page that holds a form open takes it as the server's newer answer and
 * redraws - a manager closing the form while a respondent has it open, or an end that came.
 */
export function windowRefusalState(code: string | null): FormWindowState | null {
  if (code === 'FORM_CLOSED') return 'closed';
  if (code === 'FORM_NOT_OPEN_YET') return 'not-yet';
  return null;
}

/**
 * Whether a form's opening is still to come: it takes no answer yet, so the list offers no
 * "Clore le formulaire" (the server refuses it, `FORM_CLOSE_NOT_OPEN_YET`).
 */
export function opensLater(
  form: Partial<WindowFields> | null | undefined,
  nowMs: number = Date.now()
): boolean {
  return formWindowState(form, nowMs) === 'not-yet';
}

/**
 * Whether a form's end has passed (the manager's close, or a date that came): the list shows
 * "Ferme" and both fill pages draw the closed notice. An end still to come is a scheduled close.
 */
export function isClosedForm(
  form: Partial<WindowFields> | null | undefined,
  nowMs: number = Date.now()
): boolean {
  return formWindowState(form, nowMs) === 'closed';
}
