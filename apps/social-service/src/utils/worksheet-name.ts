/**
 * A NAME EXCEL WILL ACCEPT FOR A WORKSHEET, MADE FROM TEXT A PERSON CHOSE.
 *
 * Every export names its sheet after something typed in the app - a form's title, a space's name -
 * and Excel (ExcelJS enforces it at `addWorksheet`, by THROWING) refuses `* ? : \ / [ ]`, a single
 * quote at either end, an empty name and the reserved `History`, and keeps at most 31 characters.
 * A form titled "Service 19/11" made the whole export a 500 in production (2026-11-13), so the name
 * is made acceptable HERE, once, for every export, rather than trusted.
 *
 * A refused character becomes `-` (a date "19/11" stays readable as "19-11"); the result is cut to
 * 31 characters and trimmed AFTER the cut, so a cut cannot leave a trailing quote or space.
 *
 * @param name The text the sheet is named after.
 * @param fallback Used when nothing acceptable is left; must itself be a valid name.
 * @returns A name `addWorksheet` accepts.
 */
export function safeWorksheetName(name: string, fallback = '-'): string {
  const cleaned = name
    .replace(/[*?:\\/[\]]/g, '-')
    .slice(0, 31)
    .replace(/^[\s']+|[\s']+$/g, '');
  return cleaned === '' || cleaned === 'History' ? fallback : cleaned;
}
