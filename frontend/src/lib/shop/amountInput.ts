import { Log } from '$lib/utils/Log';

/** A key of the in-app amount keypad: a digit, the decimal separator or the backspace. */
export type AmountKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | ',' | 'back';

/** Cents a quick-amount chip offers; the product's own minimum is applied by the caller. */
export const QUICK_AMOUNTS_CENTS: readonly number[] = [500, 1000, 2000, 5000];

/** Longest integer part a buffer accepts: keeps cents inside Number.MAX_SAFE_INTEGER, not a price cap. */
const MAX_INTEGER_DIGITS = 9;
const MAX_DECIMAL_DIGITS = 2;

/**
 * Applies one keypad press to the typed buffer (`"12,5"`). The buffer is a string so the display can
 * show exactly what was typed (a trailing separator, a trailing zero) - a number could not.
 * A leading zero is dropped, a second separator and a third decimal are ignored.
 */
export function applyAmountKey(buffer: string, key: AmountKey): string {
  if (key === 'back') return buffer.slice(0, -1);
  const [integer, decimal] = buffer.split(',') as [string, string | undefined];
  if (key === ',') {
    if (decimal !== undefined) return buffer;
    return `${integer === '' ? '0' : integer},`;
  }
  if (decimal !== undefined) {
    return decimal.length >= MAX_DECIMAL_DIGITS ? buffer : `${buffer}${key}`;
  }
  if (integer.length >= MAX_INTEGER_DIGITS) {
    Log.d('amountInput: integer part full, key ignored');
    return buffer;
  }
  if (integer === '0') return key === '0' ? buffer : key;
  return `${buffer}${key}`;
}

/**
 * Parses a typed buffer into integer cents with string arithmetic, never a float (`1,15 * 100` is
 * `114.99999999999999`). An empty buffer or a zero amount is `undefined`: nothing to charge.
 */
export function bufferToCents(buffer: string): number | undefined {
  if (buffer === '') return undefined;
  const [integer, decimal = ''] = buffer.split(',');
  const cents = Number(integer || '0') * 100 + Number(decimal.padEnd(MAX_DECIMAL_DIGITS, '0'));
  return Number.isFinite(cents) && cents > 0 ? cents : undefined;
}

/** Cents to a typed buffer, so a chip's amount can be edited by the keypad (`1250` -> `"12,5"`). */
export function centsToBuffer(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  if (rest === 0) return String(whole);
  return `${whole},${String(rest).padStart(2, '0').replace(/0$/, '')}`;
}

/**
 * Localised amount (`15,00 EUR` in French, `EUR 15.00` in English) through Intl, so the separator and
 * the currency position follow the reader. `trimWhole` drops `,00` from a whole amount (chips: `5 EUR`).
 */
export function formatAmountCents(
  cents: number,
  currency: string,
  locale: string,
  trimWhole = false
): string {
  const whole = trimWhole && cents % 100 === 0;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    ...(whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
  }).format(cents / 100);
}

/** The currency's symbol in a locale (`EUR` is the euro sign), shown after the typed digits. */
export function currencySymbol(currency: string, locale: string): string {
  return (
    new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() })
      .formatToParts(0)
      .find((p) => p.type === 'currency')?.value ?? currency.toUpperCase()
  );
}

/** The decimal separator of a locale, for the keypad key. */
export function decimalSeparator(locale: string): string {
  return (
    new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === 'decimal')?.value ?? ','
  );
}

/** The amount typed so far, with the separator the locale uses; `0` when nothing is typed yet. */
export function formatBuffer(buffer: string, locale: string): string {
  return (buffer === '' ? '0' : buffer).replace(',', decimalSeparator(locale));
}
