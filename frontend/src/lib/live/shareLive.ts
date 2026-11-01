import { copyPublicShareLink } from '$lib/utils/copyShareLink';
import { publicAppUrl } from '$lib/utils/publicAppUrl';
import { canShareOut, runShareOut, shareTextOut } from '$lib/sharing/shareOut';

/**
 * WHAT A LIVE'S SHARE LINK IS: `/lives/<id>` on the public origin, the live's own page
 * (`routes/lives/[liveId]`). It carries the id and nothing else: the page opens the viewer for a
 * reader the server lets in (`assertMayWatch`) and says "this live has ended" to everyone else, so
 * the link grants nothing. The same route is the target of the "X est en live" push.
 */
export function liveSharePath(liveId: string): string {
  return `/lives/${encodeURIComponent(liveId)}`;
}

/** The one link both surfaces share. */
export function liveShareUrl(liveId: string): string {
  return publicAppUrl(liveSharePath(liveId));
}

/**
 * Shares the live's link with the SAME two mechanisms a post uses (`posts/sharePost.ts`): the
 * system share sheet where the build has one (`canShareOut`, the phone apps), otherwise a copy to
 * the clipboard with the helper's toast. Nothing here touches the camera or the recorder.
 */
export function shareLiveLink(liveId: string): void {
  if (canShareOut()) {
    void runShareOut('the live link', () => shareTextOut(liveShareUrl(liveId)));
    return;
  }
  void copyPublicShareLink(liveSharePath(liveId));
}
