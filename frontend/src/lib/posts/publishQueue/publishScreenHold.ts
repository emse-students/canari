import type { PublishView } from './publishQueue';

/** The phases during which the device is doing the work of a publish, rather than waiting. */
const WORKING: ReadonlySet<PublishView['phase']> = new Set([
  'preparing',
  'uploading',
  'publishing',
]);

/**
 * Whether the screen should stay on for these rows: while one is being prepared, sent or created.
 *
 * WHY (2026-11-24, an Android 1.7.3 log): a CanaReel on a slow link, watched by a member who never
 * left the app. The screen went to sleep on its timeout (shortened by battery saver), Android
 * stopped the activity - the page hidden, `[LIFECYCLE] App in background` - and the stopped app
 * lost the network within seconds: every attempt died at its upload. A publish being worked on
 * keeps the screen on, as a call and a live do; a post WAITING for the network, paused or stopped
 * does not, so a queue that cannot progress never holds a phone awake.
 */
export function publishHoldsTheScreen(views: readonly PublishView[]): boolean {
  return views.some((v) => WORKING.has(v.phase));
}
