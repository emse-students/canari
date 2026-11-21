import type { ResumableAnswer } from '$lib/forms/api';

/**
 * WHEN THE FORM PAGE OFFERS "REPRENDRE LE PAIEMENT" (owner decision of 2026-11-21; forms.md, "A
 * released payment is resumed on the same answer").
 *
 * The server decides what may be resumed - the answer's status, the form open, a free seat, online
 * payment accepted - and names it in `GET forms/:id/check` (`resumable`). The page adds only what IT
 * knows since: an answer sent or a payment started on this screen, a change being edited, a form
 * that closed while the page was open, payments paused, a preview. Nothing here is a clock.
 */
export function offersPaymentResume(state: {
  resumable: ResumableAnswer | null | undefined;
  submitted: boolean;
  paymentPending: boolean;
  editing: boolean;
  closed: boolean;
  notOpenYet: boolean;
  paymentsPaused: boolean;
  preview: boolean;
}): boolean {
  return (
    !!state.resumable &&
    !state.submitted &&
    !state.paymentPending &&
    !state.editing &&
    !state.closed &&
    !state.notOpenYet &&
    !state.paymentsPaused &&
    !state.preview
  );
}
