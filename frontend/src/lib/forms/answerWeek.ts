import { m } from '$lib/paraglide/messages';
import { intlLocale } from '$lib/utils/intlLocale';

/**
 * AN ANONYMOUS FORM'S ANSWER IS SHOWN BY ITS WEEK, NEVER BY A DAY OR A TIME (owner, 2026-11-22,
 * charter principle 1).
 *
 * The server keeps only the start of the answer's ISO week, Monday 00:00 on the UTC wall clock
 * (`anonymousAnswerWeekSql`, `apps/social-service/src/forms/anonymous-answer-batches.ts`); a day on
 * which one person answered was a group of one the manager could put a name on. Showing that Monday
 * as a bare date would read as "answered on Monday", so the list says "semaine du 16 nov." instead.
 * The Monday is computed here as well rather than trusted, so the label means a week whatever the
 * value says.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Monday 00:00 UTC that starts the ISO week holding `iso`. */
export function anonymousAnswerWeekStart(iso: string): Date {
  const d = new Date(iso);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  // getUTCDay: Sunday 0 ... Saturday 6; an ISO week starts on Monday.
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return new Date(midnight - sinceMonday * DAY_MS);
}

/** What an anonymous answer's date reads as: "semaine du 16 nov." / "week of Nov 16". */
export function formatAnonymousAnswerWeek(iso: string): string {
  const monday = new Intl.DateTimeFormat(intlLocale(), {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(anonymousAnswerWeekStart(iso));
  return m.form_answer_week_of({ date: monday });
}
