type DateInput = Date | number | string | null | undefined;

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
