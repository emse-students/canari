import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';

const KILO = 1024;

/** Number of magnitudes above bytes that {@link formatFileSize} can express. */
const MAX_UNIT_INDEX = 3;

/**
 * Renders a value with the unit for its magnitude. Written as a switch rather
 * than an array of message references so each call site is statically visible to
 * the Paraglide compiler, which is what keeps unused locales out of the bundle.
 */
function withUnit(unit: number, value: string): string {
  switch (unit) {
    case 0:
      return m.file_size_bytes({ value });
    case 1:
      return m.file_size_kilobytes({ value });
    case 2:
      return m.file_size_megabytes({ value });
    default:
      return m.file_size_gigabytes({ value });
  }
}

/**
 * Formats a byte count for display, localized.
 *
 * The unit is a user-visible string, so it goes through Paraglide: `Ko` in
 * French is `KB` in English, and nothing about a template literal inside a
 * component would ever have told anyone that. Binary steps (1024), matching what
 * the file managers of the platforms we ship to show.
 *
 * One decimal above the byte range, dropped when it is a zero, so a size keeps
 * the precision that carries information without ever reading as "512,0 Ko":
 * "148,8 Ko", "512 Ko", "1,5 Mo", "24 Mo".
 *
 * THE DECIMAL SEPARATOR IS THE LOCALE'S TOO. It was a `toFixed` point in every
 * language, so the media viewer's panel printed "2.3 Mo" beside "1,2 MP" on the
 * same line. No digit grouping: "4096 Go", not "4 096 Go".
 */
export function formatFileSize(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;

  let value = safe;
  let unit = 0;
  while (value >= KILO && unit < MAX_UNIT_INDEX) {
    value /= KILO;
    unit++;
  }

  // Whole bytes are never fractional; larger units keep one decimal unless it
  // is a zero, which adds noise and no information.
  const rendered = new Intl.NumberFormat(getLocale(), {
    maximumFractionDigits: unit === 0 ? 0 : 1,
    useGrouping: false,
  }).format(unit === 0 ? Math.round(value) : Math.round(value * 10) / 10);
  return withUnit(unit, rendered);
}
