import { settings } from '$lib/stores/settingsStore.svelte';
import { Log } from '$lib/utils/Log';
import { NO_FURTHER_REELS, type ReelPageLoader } from './allReels';

/**
 * WHAT A FEED VIDEO OPENED FULL SCREEN SWIPES ON TO ("Nos principes", owner 2026-11-10, principle 3:
 * no trap scrolling): with "Défilement infini des CanaReels" ON (the default) the viewer's own
 * default, the CanaReels list (`undefined` lets `ReelViewer` build it); OFF, nothing after the post -
 * the viewer shows that post's media only. The CanaReels entry is the reader's explicit choice of the
 * stream and does not ask this.
 */
export function feedReelLoader(): ReelPageLoader | undefined {
  if (settings.infiniteReelsEnabled) return undefined;
  Log.d('REELS', 'infinite CanaReels off - the viewer shows the opened post only');
  return NO_FURTHER_REELS;
}
