/**
 * The call timer, as a pure function of TIMESTAMPS.
 *
 * WHY NOT A COUNTER: a `setInterval` that adds one per tick drifts by every tick a hidden tab, a
 * throttled WebView or a locked phone did not run - the timer read "00:41" after a minute in the
 * pocket. A duration derived from `connectedAt` (written once, by `CallService`, when the media path
 * first connected) is right on the first frame after the app comes back, whatever ran meanwhile. The
 * interval that repaints it only decides how OFTEN it is read, never what it says.
 */

/** Milliseconds the call has lasted: up to `endedAt` once it ended, else up to `now`. Never negative. */
export function callElapsedMs(
  connectedAt: number | null,
  endedAt: number | null,
  now: number
): number {
  if (connectedAt === null) return 0;
  const end = endedAt ?? now;
  return Math.max(0, end - connectedAt);
}

/** `mm:ss`, or `h:mm:ss` from one hour - the shape every phone's call screen uses. */
export function formatCallDuration(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(min).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
