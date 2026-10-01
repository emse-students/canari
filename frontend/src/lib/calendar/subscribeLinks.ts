/**
 * The links a reader is handed to SUBSCRIBE to an `.ics` feed, per platform.
 *
 * A subscription is saved once by the calendar app and re-polled forever, so the only thing this
 * module decides is which SCHEME reaches an app that will save it - and that differs per platform:
 *
 * - **iOS** registers `webcal:` for Calendar, which turns the link into a "Subscribe to calendar?"
 *   prompt. `webcal:` is the scheme Apple documents; `webcals:` is not, and `UIApplication.open`
 *   on a scheme nothing registered fails without a word. So iOS is handed `webcal:`.
 * - **Everywhere else** `webcals:` (the secure counterpart, equivalent to `https:`). A client that
 *   reads `webcal:` literally as `http:` - confirmed against Thunderbird - meets Cloudflare's 301
 *   to HTTPS and refuses to follow a cross-scheme redirect for a subscription.
 * - **Android has no handler for either** unless an app such as ICSx5 registers one: measured on
 *   the Mi 9T (LineageOS 23.2, Etar + Google's calendar sync adapter, 2026-10-01), `webcal:` and
 *   `webcals:` both resolve NO activity. Which is why the modal never offers this link alone.
 */

/** Platforms whose screen is a phone's, as `detectRuntimeDeviceOs` names them. */
const PHONE_OSES = new Set(['android', 'ios']);

/** True for an OS label (`detectRuntimeDeviceOs`) that names a phone platform. */
export function isPhoneOs(os: string): boolean {
  return PHONE_OSES.has(os);
}

/**
 * The calendar-app subscription link for an `https://` (or `http://`) feed URL.
 *
 * @param icsUrl - The feed's own URL; empty yields empty, so a caller can derive before it exists.
 * @param os - `detectRuntimeDeviceOs()`'s answer; only `ios` changes the scheme.
 */
export function calendarAppSubscribeUrl(icsUrl: string, os: string): string {
  if (!icsUrl) return '';
  if (os === 'ios') return icsUrl.replace(/^https?:/, 'webcal:');
  return icsUrl.replace(/^https:/, 'webcals:').replace(/^http:/, 'webcal:');
}

/**
 * Google Calendar's "add by URL" link (`render?cid=`). Google takes the feed as `http:` in `cid`
 * and fetches it itself, so this works wherever a browser does - no scheme handler involved.
 */
export function googleCalendarSubscribeUrl(icsUrl: string): string {
  if (!icsUrl) return '';
  const httpUrl = icsUrl.replace(/^https:/, 'http:');
  return `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(httpUrl)}`;
}
