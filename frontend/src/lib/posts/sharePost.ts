import { copyPublicShareLink } from '$lib/utils/copyShareLink';
import { showToast } from '$lib/stores/toast.svelte';
import { Log } from '$lib/utils/Log';
import { m } from '$lib/paraglide/messages';

/**
 * THE ONE WAY A POST IS SHARED TODAY: its public link, copied, and a toast saying so.
 *
 * Two controls ask for it - the "Partager" row of a post's menu (`PostActionsMenu`) and the send
 * button of the CanaReels rail (`ReelActionRail`). A TOAST, never a confirmation drawn in the
 * control: the menu closes on the same tap, and the viewer's rail has no room for a label. The
 * rejection is logged rather than swallowed: `writeText` refuses on an unfocused document and in
 * any non-secure context. Sending a post INTO a conversation does not exist and is not this
 * (docs/wiki/frontend/modules/reels.md, "The rail").
 */
export function sharePostLink(postId: string): void {
  Log.d('sharePost', `copying the public link of ${postId.slice(0, 8)}`);
  copyPublicShareLink(`/posts/${postId}`)
    .then(() => showToast(m.post_link_copied_label(), 'info'))
    .catch((e: unknown) => Log.d('sharePost', `share link copy failed: ${String(e)}`));
}
