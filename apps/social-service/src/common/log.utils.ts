/**
 * Strips control characters (newlines, tabs, ANSI sequences) from a string
 * before interpolating it into a log message, preventing log injection (CWE-117).
 */
export const sanitizeLog = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return 'unknown';
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\r\n\t\x00-\x1f\x7f]|\x1b\[[0-9;]*m/g, ' ');
};
