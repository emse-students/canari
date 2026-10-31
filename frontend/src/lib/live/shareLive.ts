import { copyPublicShareLink } from '$lib/utils/copyShareLink';
import { publicAppUrl } from '$lib/utils/publicAppUrl';
import { canShareOut, runShareOut, shareTextOut } from '$lib/sharing/shareOut';

/**
 * WHAT A LIVE'S SHARE LINK IS: a live has no page of its own (docs/wiki/frontend/modules/live.md,
 * "no deep link to one live"), it is a card at the top of the feed, so the link is the feed's -
 * `/posts` on the public origin. A reader who may see the live finds its card there; nobody else
 * learns anything from the link.
 */
export const LIVE_SHARE_PATH = '/posts';

/** The one link both surfaces share. */
export function liveShareUrl(): string {
  return publicAppUrl(LIVE_SHARE_PATH);
}

/**
 * Shares the live's link with the SAME two mechanisms a post uses (`posts/sharePost.ts`): the
 * system share sheet where the build has one (`canShareOut`, the phone apps), otherwise a copy to
 * the clipboard with the helper's toast. Nothing here touches the camera or the recorder.
 */
export function shareLiveLink(): void {
  if (canShareOut()) {
    void runShareOut('the live link', () => shareTextOut(liveShareUrl()));
    return;
  }
  void copyPublicShareLink(LIVE_SHARE_PATH);
}
