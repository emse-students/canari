import { CALLS_ENABLED, CALLS_VIDEO_ENABLED } from '$lib/features';
import type { CallsMode } from '$lib/utils/appVersion';
import {
  getAppVersionCheck,
  refreshAppVersionCheck,
  serverCallsMode,
} from '$lib/stores/appVersionCheck.svelte';

/**
 * WHETHER A CALL ENTRY POINT IS SHOWN: the build's switch AND the server's.
 *
 * Two locks, one per side. The build switches (`features.ts`) say what this binary CAN do and never
 * change after it ships; the server's kill switch (`platform_config.calls_mode`, B12, published by
 * `/api/version` and read by `serverCallsMode()`) says what the estate ALLOWS right now, and is how
 * production stops calls without a store release. The server refuses on every call request
 * whatever this answers - hiding is only so the reader never meets a button that can only fail.
 *
 * Pure, and given the mode rather than reading it, so a component passes `serverCallsMode()` inside
 * its own reactive expression and the button hides on the refresh that closes calls.
 */
export function callsAvailable(mode: CallsMode): boolean {
  return CALLS_ENABLED && mode !== 'off';
}

/**
 * {@link callsAvailable} on an ANSWERED kill switch, for the places that act once (an incoming
 * invite, the sibling check at session start).
 *
 * `serverCallsMode()` reads `off` until `/api/version` has answered, so an invite that arrives
 * before the first answer would be dropped for good on a reading nobody measured. When no answer
 * exists yet this awaits one (`refreshAppVersionCheck` dedupes the in-flight request), and only then
 * decides: a call is refused on an `off` the server SAID, never on the default.
 */
export async function callsAvailableAnswered(): Promise<boolean> {
  if (!CALLS_ENABLED) return false;
  if (!getAppVersionCheck()) await refreshAppVersionCheck();
  return callsAvailable(serverCallsMode());
}

/** Video too: the build carries video AND the server allows it (`audio_video`). */
export function callVideoAvailable(mode: CallsMode): boolean {
  return CALLS_VIDEO_ENABLED && mode === 'audio_video';
}
