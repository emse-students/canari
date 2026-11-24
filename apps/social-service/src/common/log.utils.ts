/**
 * Strips control characters (newlines, tabs, ANSI sequences) from a string
 * before interpolating it into a log message, preventing log injection (CWE-117).
 */
export const sanitizeLog = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return 'unknown';
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\r\n\t\x00-\x1f\x7f]|\x1b\[[0-9;]*m/g, ' ');
};

/**
 * One line for a caught error: `name: message`, or its text for anything that is not an error.
 *
 * THE ERROR GOES IN THE MESSAGE. Passed as Nest's second `logger.warn` argument it is read as the
 * CONTEXT name and prints as a second, unexplained line. Duck-typed rather than `instanceof Error`:
 * a DOMException (an `AbortSignal` timeout) is not one in every realm. Sanitised like any value
 * interpolated into a log line.
 */
export const describeError = (e: unknown): string => {
  const named =
    typeof e === 'object' && e !== null ? (e as { name?: unknown; message?: unknown }) : null;
  if (typeof named?.name !== 'string' || typeof named.message !== 'string') {
    return sanitizeLog(String(e));
  }
  return sanitizeLog(`${named.name}: ${named.message}`);
};
