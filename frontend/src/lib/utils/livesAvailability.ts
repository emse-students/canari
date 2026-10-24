import { LIVE_ENABLED } from '$lib/features';
import type { LivesMode } from '$lib/utils/appVersion';

/**
 * WHETHER A LIVE SURFACE IS SHOWN - the live card at the top of the feed, the viewer, the
 * composer's Live chip: the build's switch AND the server's.
 *
 * Two locks, one per side, as for calls (`callsAvailability.ts`). The build switch
 * (`LIVE_ENABLED`, `features.ts`) says what this binary CAN do and never changes after it ships;
 * the server's kill switch (`platform_config.lives_mode`, published by `/api/version` and read by
 * `serverLivesMode()`) says what the estate ALLOWS right now, and is how production stops lives
 * without a store release. The server answers 404 on every live request whatever this says -
 * hiding is only so the reader never meets a card or a chip that can only fail.
 *
 * Pure, and given the mode rather than reading it, so a component passes `serverLivesMode()` inside
 * its own reactive expression and the surface hides on the refresh that closes lives.
 */
export function livesAvailable(mode: LivesMode): boolean {
  return LIVE_ENABLED && mode === 'on';
}
