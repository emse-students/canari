/**
 * A REMOTE VALUE MUST NOT BE ABLE TO WRITE A LOG LINE OF ITS OWN.
 *
 * A log entry holding a raw `\n` is two entries, and the second one is whatever the sender chose
 * (CWE-117). That matters more here than the severity suggests: this project's standing method is
 * that a heal which works is not a heal that was OBSERVED, and the user asked for the logs to be
 * read on every campaign pass. Evidence a peer can forge is not evidence.
 *
 * IT LIVED INSIDE `WebMlsService.ts` AS A PRIVATE FUNCTION, and that is why it was applied to two
 * lines and not to the others: `BaseMlsService.ts` could not reach it, so its own remote ids went
 * in raw. A sanitiser one file can call is a sanitiser most call sites will not.
 *
 * WHY THE CR/LF PASS IS SEPARATE AND FIRST, when one character class would do it in a single
 * `replace`. It was one class - `/[\r\n\t\p{Cc}]/gu` - and CodeQL kept reporting the two lines
 * that already used it, because a `\p{Cc}` property escape is outside the regexp model its
 * log-injection query reasons about. The behaviour was right and the tool could not see it, so
 * every future call site would have carried an alert that no fix would clear. Splitting the pass
 * changes nothing about the output - the control class still catches everything the first pass
 * did not - and makes the newline strip the plain, modelled form.
 */

/**
 * The longest a single interpolated value may be in a log line.
 *
 * Not a security limit - a readability one. An unbounded id or error string turns one line into a
 * screen, which is the same harm as forging a line by a slower route.
 */
export const MAX_LOGGED_VALUE_LENGTH = 200;

/**
 * Makes a remote-controlled value safe to interpolate into a log line.
 *
 * Every newline, tab and control character becomes a space, and the result is truncated. Use it on
 * ANY value that crossed the network - a user id, a device id, a group id, a queued-message id, a
 * frame type the server chose, an error message from a peer.
 */
export function sanitizeForLog(value: string): string {
  return value
    .replace(/[\r\n]/g, ' ')
    .replace(/[\t\p{Cc}]/gu, ' ')
    .slice(0, MAX_LOGGED_VALUE_LENGTH);
}
