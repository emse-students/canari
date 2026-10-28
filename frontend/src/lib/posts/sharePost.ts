import { copyPublicShareLink } from '$lib/utils/copyShareLink';
import { publicAppUrl } from '$lib/utils/publicAppUrl';
import { shareTextOut } from '$lib/sharing/shareOut';
import { landShareOn } from '$lib/sharing/shareLanding';
import { incomingShare } from '$lib/stores/incomingShare.svelte';
import { showToast } from '$lib/stores/toast.svelte';
import { Log } from '$lib/utils/Log';
import { m } from '$lib/paraglide/messages';

/**
 * HOW A POST IS SHARED: the three rows of its share sheet (`PostShareSheet`), opened by the
 * "Partager" row of a post's menu (`PostActionsMenu`) and by the send button of the CanaReels rail
 * (`ReelViewer`). Every row shares the SAME thing - the post's link, `/posts/<id>` on the public
 * origin - and the link carries nothing but the id: a reader who may not see the post is refused by
 * the page and by the in-app card alike. See `docs/wiki/frontend/sharing.md`, "A post or a reel,
 * shared from its sheet".
 */

/** The one link every row shares. */
export function postShareUrl(postId: string): string {
  return publicAppUrl(`/posts/${postId}`);
}

/**
 * Sends the post INTO a conversation: its link is offered to `conversationId` with the destination
 * already picked, and that conversation opens with the link in its composer - the road a share from
 * another app takes (`incomingShare`, `landShareOn`). The member writes a word if they like and
 * sends with Send; nothing is sent from here. In the conversation the link draws the in-app card
 * (`LinkPreviewCard`), which each reader fetches under their OWN session.
 *
 * True when the landing was published - what lets a surface drawn over the conversations (the reel
 * viewer) step aside for it; false when the link was not offered.
 */
export function sendPostLinkInApp(postId: string, conversationId: string): boolean {
  Log.i(
    'sharePost',
    `sending the link of ${postId.slice(0, 8)} into ${conversationId.slice(0, 16)}`
  );
  if (!incomingShare.offerTo(postShareUrl(postId), conversationId)) {
    Log.i('sharePost', `the link of ${postId.slice(0, 8)} was not offered`);
    return false;
  }
  landShareOn(conversationId);
  return true;
}

/**
 * Opens the system share sheet on the post's link (lot S3, `sharing/shareOut.ts`). Only offered
 * where there is one (`canShareOut`, the phone apps): the sheet's row is not drawn elsewhere.
 */
export function sharePostLinkOut(postId: string): void {
  Log.d('sharePost', `sharing the public link of ${postId.slice(0, 8)}`);
  shareTextOut(postShareUrl(postId)).catch((e: unknown) => {
    Log.d('sharePost', `the share sheet did not open: ${String(e)}`);
    showToast(m.share_out_failed(), 'error');
  });
}

/**
 * Copies the post's public link, and a toast says so. A TOAST, never a confirmation drawn in the
 * control: the sheet closes on the same tap. The rejection is logged rather than swallowed:
 * `writeText` refuses on an unfocused document and in any non-secure context.
 */
export function copyPostLink(postId: string): void {
  Log.d('sharePost', `copying the public link of ${postId.slice(0, 8)}`);
  copyPublicShareLink(`/posts/${postId}`)
    .then(() => showToast(m.post_link_copied_label(), 'info'))
    .catch((e: unknown) => Log.d('sharePost', `share link copy failed: ${String(e)}`));
}
