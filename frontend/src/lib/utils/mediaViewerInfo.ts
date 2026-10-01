/**
 * What the media viewer SAYS about a photo or a video: the date-and-time title of its top bar and
 * the lines of its information panel (`MediaLightbox.svelte`). Ported from MiGallery's viewer.
 *
 * Pure functions, no DOM and no Paraglide import: the locale, the clock, the time zone and the two
 * relative labels are passed in, so `mediaViewerInfo.test.ts` pins them deterministically.
 *
 * WHAT IS NOT HERE, AND WHY: a camera, an exposure, a place. MiGallery reads them from EXIF through
 * Immich; Canari's media is end-to-end encrypted, the server holds an opaque blob, and the client
 * compresses a photo before sending it, which drops its EXIF. The panel shows what the CLIENT knows:
 * who sent it, when, its name, its size and its pixel dimensions.
 */

import { calendarDay, type RelativeDayLabels } from './dates';

/** A moment as the call sites carry it: a message's `Date`, a post's ISO string, a millisecond count. */
export type ViewerDateInput = Date | string | number;

/**
 * What a call site knows about the media it opens, for the viewer's title and information panel.
 * Every field is optional: a photo still in the composer has no sender and no date yet.
 */
export interface MediaViewerInfo {
  /** A user who sent it (a message); the panel resolves the name itself. */
  senderId?: string;
  /** A publisher that is not resolved from a user id (a post: its association, or "Anonyme"). */
  senderName?: string;
  sentAt?: ViewerDateInput;
  fileName?: string;
  /** Plaintext size, as the media descriptor records it. */
  sizeBytes?: number;
  /** Declared by the sender; the viewer prefers what it measures on the element it shows. */
  width?: number;
  height?: number;
}

/** The viewer's title: the day on the first line, the time on the second (Google Photos). */
export interface ViewerDateTitle {
  date: string;
  time: string;
}

export interface DateTitleOptions {
  /** BCP 47 locale, the Paraglide one (`getLocale()`). */
  locale: string;
  labels: RelativeDayLabels;
  /** The clock "today" is measured against; injected for the tests. */
  now?: Date;
  /** IANA zone; defaults to the browser's. */
  timeZone?: string;
}

/** The instant `value` names, or `null` when it is missing or unparseable. */
function toInstant(value: ViewerDateInput | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const instant = value instanceof Date ? value : new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * The viewer's title for something sent at `value`: "Aujourd'hui" / "Hier" for the two most recent
 * days, then the weekday, day and short month, plus the year only when it is not the current one;
 * the time on its own line. `null` for a missing or unparseable date, so the caller shows the file
 * name instead of "Invalid Date".
 */
export function formatViewerDateTitle(
  value: ViewerDateInput | null | undefined,
  { locale, labels, now = new Date(), timeZone }: DateTitleOptions
): ViewerDateTitle | null {
  const taken = toInstant(value);
  if (!taken) return null;

  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(taken);

  const daysAgo = calendarDay(now, timeZone) - calendarDay(taken, timeZone);
  if (daysAgo === 0) return { date: labels.today, time };
  if (daysAgo === 1) return { date: labels.yesterday, time };

  const yearOf = (d: Date) =>
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(d);
  const date = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: yearOf(taken) === yearOf(now) ? undefined : 'numeric',
  }).format(taken);
  return { date, time };
}

/** The full date and time of the information panel, never relative: it is a record, not a title. */
export function formatViewerFullDate(
  value: ViewerDateInput | null | undefined,
  locale: string,
  timeZone?: string
): string | null {
  const taken = toInstant(value);
  if (!taken) return null;
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(taken);
}

/** A picture's pixel size and its megapixels, ready for the panel's localized line. */
export interface DimensionsParts {
  width: number;
  height: number;
  /** Megapixels, one decimal, in the locale's own separator ("12,2" in French). */
  megapixels: string;
}

/** The parts of "4032 x 3024 - 12.2 MP"; `null` when either side is unknown. */
export function dimensionsParts(
  width: number | null | undefined,
  height: number | null | undefined,
  locale: string
): DimensionsParts | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  const megapixels = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    (width * height) / 1e6
  );
  return { width: Math.round(width), height: Math.round(height), megapixels };
}
