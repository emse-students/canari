import { isPhoneViewport, isSwipeNavViewport } from '$lib/utils/viewport';
import { nativeTabBar } from '$lib/navigation/nativeTabBarState.svelte';
import { Log } from '$lib/utils/Log';
import { GuideEngine } from './guideEngine.svelte';
import { guideAnchorsVersion, resolveGuideAnchor } from './guideAnchors.svelte';
import { seenHelps } from './seenHelps.svelte';
import { GUIDES } from './guides';
import type { HelpId } from './helpIds';
import type { GuideLayout } from './guideTypes';

/**
 * THE APP'S ONE GUIDE ENGINE, wired to the running app: the layout read from the viewport queries
 * and the native bar, anchors from the registry, the seen set from the account
 * (docs/wiki/frontend/guided-help.md). `GuideOverlay.svelte` drives it and draws it.
 */

/** The layout facts a step's `when`, anchor and text are decided from. */
export function currentGuideLayout(): GuideLayout {
  return {
    phone: isPhoneViewport(),
    swipe: isSwipeNavViewport(),
    nativeTabBar: nativeTabBar.status === 'native',
  };
}

/** The route the engine last saw settle, for {@link GuideEnvironment.situation}. */
let settledPath = '';

/** Called by the overlay when a route settles, so `situation` names it. */
export function noteSettledPath(pathname: string): void {
  settledPath = pathname;
}

export const guideEngine = new GuideEngine(GUIDES, {
  layout: currentGuideLayout,
  isAnchorRendered: (anchorId) => resolveGuideAnchor(anchorId) !== null,
  isSeen: (id) => seenHelps.has(id),
  seenReady: () => seenHelps.ready,
  markSeen: (id) => seenHelps.markSeen(id),
  situation: () => `${settledPath}#${guideAnchorsVersion()}`,
});

/**
 * Replays a help - the Settings button. The help runs at the next quiet moment on a route it applies
 * to; `goto` is the caller's, because only the caller knows whether to leave the page it is on.
 */
export function replayGuide(id: HelpId): void {
  Log.i('guide', `replay of ${id} asked from the interface`);
  guideEngine.request(id);
}
