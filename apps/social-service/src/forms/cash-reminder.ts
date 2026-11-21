/**
 * THE MEMBER IS TOLD ONCE BEFORE THEIR CASH HOLD EXPIRES (owner decision of 2026-11-21, "launch
 * now: payment resume"). A `pending_cash` answer holds its seat until `cashExpiresAt`; past it the
 * hourly job moves it to `expired` and the seat is lost - and nothing told the member it was coming.
 *
 * ONE NOTICE, NOT A NAG (principle 3, "your attention is not for sale"): one bell row per answer,
 * claimed on the row (`cashReminderNotifiedAt`), in the `forms` category the member may mute. No
 * push: a cash deadline is days long and read in the app; a push key needs the native tables.
 *
 * WHEN, from the row alone: `cashReminderDueAt`, written by `submit` beside the expiry, so the job
 * compares one stored instant with the database's `now()` - the same shape as the expiry itself.
 */

/** How long before the expiry the notice comes, at most: a day, the time to reach the organiser. */
export const CASH_REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * When the notice is owed for a hold that expires at `expiresAt` and starts at `now`: 24 hours
 * before the expiry, or HALFWAY through a hold shorter than two days - a one-day hold is not
 * announced the moment it is taken, which would tell the member nothing they did not just read.
 */
export function cashReminderDueAt(expiresAt: Date, now: Date): Date {
  const hold = expiresAt.getTime() - now.getTime();
  const lead = Math.min(CASH_REMINDER_LEAD_MS, Math.max(0, hold) / 2);
  return new Date(expiresAt.getTime() - lead);
}

/** One answer owed its notice, as `FormsService.dueCashReminders` reads it. */
export interface DueCashReminder {
  submissionId: string;
  userId: string;
  formId: string;
  formTitle: string | null;
  associationId: string | null;
  associationName: string | null;
  associationLogoUrl: string | null;
}
