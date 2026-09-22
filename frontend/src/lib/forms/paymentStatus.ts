import { m } from '$lib/paraglide/messages';

/**
 * WHAT A SUBMISSION'S PAYMENT STATUS IS CALLED, AND WHAT COLOUR IT IS, IN ONE PLACE.
 *
 * These were expressions inside `FormSubmissionsTable.svelte` until 2026-09-22, which was correct
 * for exactly as long as the table was the only thing that named a status. The xlsx export names
 * them too - it used to write the raw enum, `free`, into a column a person reads - and a second copy
 * of this mapping is one added status away from a file and a screen disagreeing about the same row.
 *
 * THE LIST IS EXPORTED AS WELL AS THE LOOKUP, because the export has to send EVERY label it knows to
 * a server that knows none: a service has no Paraglide and no locale, so the words have to travel
 * from the only place that has both.
 */
export const PAYMENT_STATUSES = [
  'free',
  'pending',
  'pending_cash',
  'paid',
  'cancelled',
  'expired',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * The label a person reads for a payment status.
 *
 * An unknown status returns ITSELF rather than a placeholder: a value this app does not know is a
 * fact about the row, and blanking it would hide the one case worth seeing.
 */
export function statusLabel(status: string): string {
  if (status === 'free') return m.form_status_free();
  if (status === 'pending') return m.form_status_pending();
  if (status === 'pending_cash') return m.form_status_pending_cash();
  if (status === 'paid') return m.form_status_paid();
  if (status === 'cancelled') return m.form_status_cancelled();
  if (status === 'expired') return m.form_status_expired();
  return status;
}

/** The pill's colours, by what the status MEANS: settled, owed, or refused. */
export function statusClass(status: string): string {
  if (status === 'paid')
    return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
  if (status === 'free') return 'bg-cn-border/40 text-text-muted';
  if (status === 'pending' || status === 'pending_cash')
    return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300';
  return 'bg-red-err/20 text-red-err';
}

/** Every status paired with its label, which is what the export contract carries. */
export function statusLabels(): Record<string, string> {
  return Object.fromEntries(PAYMENT_STATUSES.map((status) => [status, statusLabel(status)]));
}
