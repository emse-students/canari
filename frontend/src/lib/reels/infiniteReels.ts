import { settings } from '$lib/stores/settingsStore.svelte';
import { Log } from '$lib/utils/Log';

/**
 * WHETHER A FEED VIDEO OPENED FULL SCREEN SWIPES ON TO THE CANAREELS STREAM ("Nos principes", owner
 * 2026-11-10, principle 3: no trap scrolling): with "Défilement infini des CanaReels" ON (the
 * default) it goes on to the stream, in the reader's order and with its switch
 * (`reels/reelStream.svelte.ts`, owner 2026-11-11); OFF, nothing after the post - the viewer shows
 * that post's media only (`NO_FURTHER_REELS`), and draws no switch, since there is no list to order.
 * The CanaReels entry is the reader's explicit choice of the stream and does not ask this.
 */
export function feedReelsContinue(): boolean {
  if (settings.infiniteReelsEnabled) return true;
  Log.d('REELS', 'infinite CanaReels off - the viewer shows the opened post only');
  return false;
}
