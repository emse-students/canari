type DateInput = Date | number | string | null | undefined;

/**
 * Parses a persisted Unix-ms timestamp from local storage.
 * On Android/Tauri SQL, INTEGER columns may be returned as strings.
 */
export function readStoredTimestampMs(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/** Coerces arbitrary values to a valid `Date`, or returns `fallback` (default: now). */
export function toValidDate(value: DateInput, fallback: Date = new Date()): Date {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : fallback;
  }
  if (typeof value === 'number' || typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : fallback;
  }
  return fallback;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 24-hour local time, e.g. `14:30`. Never throws on invalid input. */
export function formatTime24(value: DateInput, fallback: Date = new Date()): string {
  const d = toValidDate(value, fallback);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function isToday(date: Date): boolean {
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

const MS_PER_DAY = 86_400_000;

/**
 * Days since the Unix epoch of the calendar day `instant` falls on IN `timeZone` (default: the
 * browser's). Two of these subtract to a whole number of days, whatever DST did in the zone.
 */
export function calendarDay(instant: Date, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / MS_PER_DAY);
}

/** The two localized words that replace a date close to now (Paraglide, passed by the caller). */
export interface RelativeDayLabels {
  today: string;
  yesterday: string;
}

/** How far back the weekday alone still names one day without ambiguity: within the last week. */
const WEEKDAY_ONLY_MAX_DAYS = 6;

/**
 * The SHORTEST HONEST NAME OF A DAY, as a conversation's day separator and its floating pill show
 * it: "Aujourd'hui", "Hier", then the weekday alone ("Mercredi") while it can only mean one day,
 * then day and month ("23 septembre"), and the year only when it is not the current one. A long
 * "mercredi 23 septembre 2026" on every separator was the label that overflowed the pill on a
 * phone; most of it said nothing the reader did not already know.
 *
 * A day in the future (a skewed clock) is never called by its weekday, which would read as past.
 *
 * @param date the day to name
 * @param locale BCP 47 locale for `Intl` (the Paraglide one)
 * @param labels the localized "today" / "yesterday"
 * @param now the clock "today" is measured against; injected for the tests
 */
export function formatDayLabel(
  date: Date,
  locale: string,
  labels: RelativeDayLabels,
  now: Date = new Date()
): string {
  const daysAgo = calendarDay(now) - calendarDay(date);
  if (daysAgo === 0) return labels.today;
  if (daysAgo === 1) return labels.yesterday;
  const options: Intl.DateTimeFormatOptions =
    daysAgo > 1 && daysAgo <= WEEKDAY_ONLY_MAX_DAYS
      ? { weekday: 'long' }
      : {
          day: 'numeric',
          month: 'long',
          year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
        };
  const text = new Intl.DateTimeFormat(locale, options).format(date);
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/**
 * An instant as the `datetime-local` text an input shows, in the viewer's own zone.
 *
 * THREE COPIES OF THIS EXISTED, and the one in `calendar/eventForm.ts` carried a comment saying it
 * had already absorbed the duplicates - while `AssociationCalendarSection.svelte` still held its
 * own, `pad` and all. It is a date function, not a calendar function, so it lives here with the
 * other ones and nothing has to decide which module owns it next time a surface needs it.
 *
 * `slice(0, 16)` on an ISO string is the tempting version and it is WRONG: that text is UTC, and an
 * input labelled "local" would show a reader in Paris a time one or two hours off their own.
 *
 * @param iso The instant, as stored.
 * @returns `YYYY-MM-DDTHH:mm` in the viewer's zone.
 */
export function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
