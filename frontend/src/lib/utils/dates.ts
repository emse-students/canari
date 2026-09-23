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

export function isYesterday(date: Date): boolean {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  );
}

const frLongDateFormatter = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** French long date, e.g. `lundi 5 mai 2025`. */
export function formatLongDateFr(date: Date): string {
  return frLongDateFormatter.format(date);
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
