import { m } from '$lib/paraglide/messages';
import { Log } from '$lib/utils/Log';

/**
 * A LIMITED FORM'S WAITING LIST, AS THE PAGES SEE IT (owner decision of 2026-11-23; forms.md, "A
 * waiting list on a limited form").
 *
 * The server keeps the list and decides everything: who may join (`check.waitlist.open`), the rank,
 * and the promotion when a place frees. The pages only draw it - the rank card, the "join" send, the
 * manager's list in arrival order - and add what THEY know since: an answer sent on this screen, a
 * change being edited, a preview.
 */

/** The status of an answer waiting in line: it holds no seat and is charged nothing. */
export const WAITING_STATUS = 'waiting';

/**
 * The status of a promoted answer whose online payment is owed: a registration, holding its seat
 * for the payment window, paid through "Reprendre le paiement".
 */
export const PAYMENT_DUE_STATUS = 'payment_due';

/** The waiting list as `GET forms/:id/check` names it; absent from a server older than it. */
export interface WaitlistView {
  /** An answer given now while the form is full would wait in line. */
  open: boolean;
  /** The caller's own place, 1 for the first, while their answer waits; else null. */
  rank: number | null;
}

/** Whether an answer row is waiting in line rather than registered. */
export function isWaiting(sub: { paymentStatus: string }): boolean {
  return sub.paymentStatus === WAITING_STATUS;
}

/**
 * The waiting answers of a form in ARRIVAL ORDER (`waitlistOrder`, a bigint the server sends as
 * text), the oldest first - the order the promotion follows. The manager never reorders it.
 */
export function waitingInOrder<
  T extends { paymentStatus: string; waitlistOrder?: string | null; createdAt: string },
>(subs: readonly T[]): T[] {
  return subs.filter(isWaiting).sort((a, b) => {
    const left = BigInt(a.waitlistOrder ?? '0');
    const right = BigInt(b.waitlistOrder ?? '0');
    if (left !== right) return left < right ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** The answers that are registrations: every row but the waiting ones. */
export function registeredOnly<T extends { paymentStatus: string }>(subs: readonly T[]): T[] {
  return subs.filter((sub) => !isWaiting(sub));
}

/** The caller's place in line, said in the reader's language ("3e sur la liste d'attente"). */
export function waitlistRankText(rank: number): string {
  return rank === 1 ? m.form_waitlist_rank_first() : m.form_waitlist_rank({ rank });
}

/**
 * Whether the fill page offers to JOIN the waiting list instead of the disabled "Complet": the
 * server says the list is open and the form full, and nothing on this screen already answered
 * for the person.
 */
export function offersWaitlistJoin(state: {
  waitlist: WaitlistView | null | undefined;
  formFull: boolean;
  submitted: boolean;
  editing: boolean;
  closed: boolean;
  notOpenYet: boolean;
  maySubmit: boolean;
  preview: boolean;
}): boolean {
  const offered =
    !!state.waitlist?.open &&
    state.formFull &&
    !state.submitted &&
    !state.editing &&
    !state.closed &&
    !state.notOpenYet &&
    state.maySubmit &&
    !state.preview;
  if (state.formFull && state.waitlist && !offered) {
    Log.d(
      'FormView',
      `waiting list not offered (open=${state.waitlist.open} submitted=${state.submitted} closed=${state.closed})`
    );
  }
  return offered;
}

/** The form settings the waiting list depends on, as the editors hold them. */
export interface WaitlistSettings {
  maxSubmissions: number | undefined | null;
  anonymous: boolean;
  allowMultipleSubmissions: boolean;
}

/**
 * Whether the waiting list can apply to a form so set - the server's own rule (`waitlistApplies`):
 * a capacity, named answers (a line needs someone to promote), one answer per person (a second
 * answer is not a place in line).
 */
export function waitlistSettable(form: WaitlistSettings): boolean {
  return (
    !!form.maxSubmissions &&
    form.maxSubmissions > 0 &&
    !form.anonymous &&
    !form.allowMultipleSubmissions
  );
}

/**
 * What a form save sends of the switch: nothing to an estate that does not keep the list (it would
 * strip it), and `false` on a form where the list cannot apply, so a switch left on under a setting
 * that rules it out is never stored as on.
 */
export function waitlistPayload(
  estateServes: boolean,
  enabled: boolean,
  form: WaitlistSettings
): { waitlistEnabled?: boolean } {
  if (!estateServes) return {};
  return { waitlistEnabled: enabled && waitlistSettable(form) };
}
