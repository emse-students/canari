import { copyPublicShareLink } from '$lib/utils/copyShareLink';
import { publicAppUrl } from '$lib/utils/publicAppUrl';
import { canShareOut, shareTextOut } from '$lib/sharing/shareOut';
import { showToast } from '$lib/stores/toast.svelte';
import { Log } from '$lib/utils/Log';
import { m } from '$lib/paraglide/messages';

/**
 * HOW A POST IS SHARED: its public link, through the system share sheet on a phone, copied elsewhere.
 *
 * Two controls ask for it - the "Partager" row of a post's menu (`PostActionsMenu`) and the send
 * button of the CanaReels rail (`ReelActionRail`). On the phone apps the link goes to the OS sheet
 * (`sharing/shareOut.ts`, lot S3), and the menu keeps a "Copier le lien" row (`copyPostLink`). On
 * the web and the desktop app there is no native sheet, so sharing IS copying. Sending a post INTO
 * a conversation does not exist and is not this (docs/wiki/frontend/modules/reels.md, "The rail").
 */
export function sharePostLink(postId: string): void {
  if (!canShareOut()) {
    copyPostLink(postId);
    return;
  }
  Log.d('sharePost', `sharing the public link of ${postId.slice(0, 8)}`);
  shareTextOut(publicAppUrl(`/posts/${postId}`)).catch((e: unknown) => {
    Log.d('sharePost', `the share sheet did not open: ${String(e)}`);
    showToast(m.share_out_failed(), 'error');
  });
}

/**
 * Copies the post's public link, and a toast says so. A TOAST, never a confirmation drawn in the
 * control: the menu closes on the same tap, and the viewer's rail has no room for a label. The
 * rejection is logged rather than swallowed: `writeText` refuses on an unfocused document and in any
 * non-secure context.
 */
export function copyPostLink(postId: string): void {
  Log.d('sharePost', `copying the public link of ${postId.slice(0, 8)}`);
  copyPublicShareLink(`/posts/${postId}`)
    .then(() => showToast(m.post_link_copied_label(), 'info'))
    .catch((e: unknown) => Log.d('sharePost', `share link copy failed: ${String(e)}`));
}
