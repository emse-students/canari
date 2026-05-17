import { format } from 'date-fns';

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

/** `date-fns` `format` that never throws on invalid input. */
export function formatDateSafe(
  value: DateInput,
  formatStr: string,
  fallback: Date = new Date()
): string {
  return format(toValidDate(value, fallback), formatStr);
}
