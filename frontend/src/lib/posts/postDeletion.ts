import { m } from '$lib/paraglide/messages';
import { showConfirm } from '$lib/stores/confirm.svelte';
import { Log } from '$lib/utils/Log';
import { deletePost } from './api';

/** What a delete request came to: the post is gone, or the author kept it at the confirmation. */
export type PostDeletionOutcome = 'deleted' | 'declined';

/**
 * Deletes a post AFTER the author confirms it, in the app's own dialog.
 *
 * THE ONE PATH EVERY "DELETE THIS POST" CONTROL TAKES. The post menu's "Supprimer" and the
 * scheduled-posts panel both used to call the API on the tap, so a slip of the finger destroyed a
 * post while the reel editor and the review ask before
 * discarding far less (Mi 9T reading of `v1.2.4-alpha.2`). A deletion cannot be undone, hence
 * `danger`.
 *
 * A failed request REJECTS, as `deletePost` does: each caller owns how its failure is shown.
 */
export async function deletePostAfterConfirm(postId: string): Promise<PostDeletionOutcome> {
  Log.d('postDeletion', `asking before deleting post ${postId}`);
  const confirmed = await showConfirm(m.post_delete_confirm(), {
    confirmLabel: m.common_delete_button(),
    danger: true,
  });
  if (!confirmed) {
    Log.d('postDeletion', `kept post ${postId} - declined at the confirmation`);
    return 'declined';
  }
  await deletePost(postId);
  Log.d('postDeletion', `deleted post ${postId}`);
  return 'deleted';
}
