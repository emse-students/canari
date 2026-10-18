/**
 * THE CLOCK A BOOKING SCREEN REDRAWS ON (WP-B5). A page left open across a space's opening, or
 * across a unit's start, must not keep drawing what was true when it loaded. This ticks
 * `onTick(Date.now())` every minute, exactly at `atMs` (the opening) when it is still to come, and
 * when the page becomes visible again (a phone woken from sleep, whose timers did not run).
 *
 * It only REDRAWS: what is drawn bookable is the device's reading, and the server answers every
 * request on its own clock (`bookingWindow.ts`).
 */
import { Log } from '$lib/utils/Log';

const MINUTE_MS = 60_000;
/** The longest delay `setTimeout` keeps (2^31 - 1 ms, ~24.8 days); the minute tick covers beyond. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Starts the ticks; the returned function stops them all. */
export function redrawEveryMinuteAndAt(
  atMs: number | null,
  onTick: (nowMs: number) => void
): () => void {
  const tick = () => onTick(Date.now());
  const minute = setInterval(tick, MINUTE_MS);
  const delay = atMs === null ? -1 : atMs - Date.now();
  const at = delay >= 0 && delay <= MAX_TIMEOUT_MS ? setTimeout(tick, delay + 1) : null;
  if (at) Log.d('BOOKINGS', `redraw scheduled at the opening, in ${Math.round(delay / 1000)} s`);
  const onVisible = () => {
    if (document.visibilityState === 'visible') tick();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(minute);
    if (at) clearTimeout(at);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
