<script lang="ts">
  /**
   * A REEL'S COMMENTS, IN A SHEET OVER THE PLAYING REEL (user, 2026-10-19, as Instagram's Reels):
   * the rail's comment button opens it over the lower part of the page, the reel keeps playing in
   * the part above, and the sheet is the POST's own thread - the card's `PostComments`, docked, on
   * the card's write path (`posts/postCommentThread.svelte.ts`) and the card's comment report
   * (`posts/reportComment.ts`). No second copy of a rule, and no request of its own.
   *
   * THE DRAWER ITSELF - grabber, drag to close, Back, Escape, the keyboard - is the shared
   * `CommentsDrawer`, the one a post's thread opens in on a phone too (user, 2026-10-23). This file
   * keeps what is a REEL's: the viewer's copy of the post and its write path. Instagram's numbers
   * are measured in docs/wiki/frontend/modules/reels.md, "Instagram reference".
   */
  import PostComments from '$lib/components/posts/PostComments.svelte';
  import CommentsDrawer from '$lib/components/shared/CommentsDrawer.svelte';
  import ReportReasonDialog from '$lib/components/moderation/ReportReasonDialog.svelte';
  import type { PostComment, PostEntity, PostMediaRef } from '$lib/posts/api';
  import { PostCommentThread, type CommentOutcome } from '$lib/posts/postCommentThread.svelte';
  import type { CommentIdentity } from '$lib/posts/postIdentity';
  import { commentCountOf } from '$lib/posts/commentChange';
  import { reportComment } from '$lib/posts/reportComment';
  import type { ReportReason } from '$lib/moderation/reasons';
  import { showToast } from '$lib/stores/toast.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The post whose thread is shown, as the viewer holds it now. */
    post: PostEntity;
    /** The signed-in reader. */
    currentUserId: string;
    authToken: string;
    /** Replaces the viewer's copy of the post: every write lands there, and the rail's count follows. */
    onChange: (next: PostEntity) => void;
    onClose: () => void;
    /** The sheet starts sliding out (X, Escape, a tap on the reel, a drag release): the reel grows back. */
    onClosing?: () => void;
  }

  let { post, currentUserId, authToken, onChange, onClose, onClosing }: Props = $props();

  let commentText = $state('');
  /** Why the last comment did not go, said beside the box. */
  let commentError = $state('');
  let commentBeingReported = $state<PostComment | null>(null);
  let reportSubmitting = $state(false);

  const thread = new PostCommentThread({
    userId: () => currentUserId,
    read: () => post,
    write: (next) => onChange(next),
    // The viewer keeps no ledger of reads: nothing reloads its reels behind a write.
    begin: () => {},
    end: () => {},
    answered: () => {},
    // Said beside the box, where the reader is looking, and not in a toast over the reel.
    fail: (message) => (commentError = message),
  });

  const comments = $derived(post.comments ?? []);
  const topLevelComments = $derived(comments.filter((c) => !c.parentId));

  async function handleAddComment(
    parentId?: string,
    media?: PostMediaRef,
    identity?: CommentIdentity
  ): Promise<CommentOutcome> {
    const text = commentText.trim();
    commentError = '';
    const outcome = await thread.add(text, parentId, media, () => (commentText = ''), identity);
    // The box was emptied when the comment was shown; a failure puts the words back.
    if (outcome === 'failed' && !commentText) commentText = text;
    return outcome;
  }

  function handleReportComment(commentId: string) {
    const comment = comments.find((c) => c.id === commentId) ?? null;
    if (!comment) {
      console.debug(`[reel-comments] report on an unknown comment ${commentId.slice(0, 8)}`);
      return;
    }
    commentBeingReported = comment;
  }

  async function submitCommentReport(reason: ReportReason) {
    const comment = commentBeingReported;
    if (!comment) return;
    reportSubmitting = true;
    const outcome = await reportComment(comment, reason);
    showToast(outcome.message, outcome.ok ? 'info' : 'error');
    reportSubmitting = false;
    commentBeingReported = null;
  }
</script>

<CommentsDrawer
  label={`reel ${post.id}`}
  {onClose}
  {onClosing}
  escapeBlocked={!!commentBeingReported}
>
  <PostComments
    postId={post.id}
    sendError={commentError}
    {comments}
    {topLevelComments}
    {commentText}
    submittingComment={thread.submitting}
    pendingCommentIds={thread.pending}
    {currentUserId}
    {authToken}
    onCommentTextChange={async (text) => {
      commentText = text;
      commentError = '';
    }}
    onAddComment={handleAddComment}
    onLikeComment={(id) => void thread.like(id)}
    onEditComment={(id, text) => thread.edit(id, text)}
    onDeleteComment={(id) => thread.remove(id)}
    onReport={handleReportComment}
    onLoadOlder={() => thread.loadMore()}
    hasMoreComments={thread.hasMore}
    loadingMore={thread.loadingMore}
    totalCommentCount={commentCountOf(post)}
  />
</CommentsDrawer>

<ReportReasonDialog
  open={!!commentBeingReported}
  title={m.report_comment_dialog_title()}
  targetPreview={commentBeingReported?.text ?? ''}
  submitting={reportSubmitting}
  onSubmit={submitCommentReport}
  onClose={() => (commentBeingReported = null)}
/>
