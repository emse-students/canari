import { formRefusal } from './answer-bounds';

/**
 * The 400 refusing a form whose end (`closedAt`) is not after its opening (`opensAt`): a window that
 * never admits an answer. Worded by the client.
 */
export const FORM_CLOSE_BEFORE_OPEN = 'FORM_CLOSE_BEFORE_OPEN';

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
