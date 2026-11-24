/**
 * Strips control characters (newlines, tabs, ANSI sequences) from a string
 * before interpolating it into a log message, preventing log injection (CWE-117).
 */
export const sanitizeLog = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return 'unknown';
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\r\n\t\x00-\x1f\x7f]|\x1b\[[0-9;]*m/g, ' ');
};

/** Text of anything, never throwing: an `Object.create(null)` or a throwing `toString` has no safe `String()`. */
const safeText = (value: unknown): string => {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
};

/** `name: message` (plus ` [code]` when one is set) for an error-shaped value, or null for anything else. */
const errorShape = (e: unknown): string | null => {
  if (typeof e !== 'object' || e === null) return null;
  const { name, message, code } = e as { name?: unknown; message?: unknown; code?: unknown };
  if (typeof name !== 'string' || typeof message !== 'string') return null;
  const coded = typeof code === 'string' || typeof code === 'number' ? ` [${code}]` : '';
  return `${name}: ${message}${coded}`;
};

/**
 * One line for a caught error: `name: message [code]`, or its text for anything that is not an error.
 *
 * THE ERROR GOES IN THE MESSAGE. Passed as Nest's second `logger.warn` argument it is read as the
 * CONTEXT name and prints as a second, unexplained line. Duck-typed rather than `instanceof Error`:
 * a DOMException (an `AbortSignal` timeout) is not one in every realm. An `AggregateError` names its
 * inner errors (its own message is only "All promises were rejected") and a `cause` follows one level
 * deep, each described the same way. NEVER THROWS: it runs in a catch, where a second failure would
 * hide the first. Sanitised like any value interpolated into a log line.
 */
export const describeError = (e: unknown): string => {
  const own = errorShape(e) ?? safeText(e);
  if (typeof e !== 'object' || e === null) return sanitizeLog(own);
  const { errors, cause } = e as { errors?: unknown; cause?: unknown };
  const inner = Array.isArray(errors)
    ? ` (${errors.map((one) => errorShape(one) ?? safeText(one)).join('; ')})`
    : '';
  const because = cause === undefined ? '' : ` <- ${errorShape(cause) ?? safeText(cause)}`;
  return sanitizeLog(`${own}${inner}${because}`);
};
