<script lang="ts">
  /**
   * A REEL'S COMMENTS, IN A SHEET OVER THE PLAYING REEL (user, 2026-10-19, as Instagram's Reels):
   * the rail's comment button opens it over the lower part of the page, the reel keeps playing in
   * the part above, and the sheet is the POST's own thread - the card's `PostComments`, docked, on
   * the card's write path (`posts/postCommentThread.svelte.ts`) and the card's comment report
   * (`posts/reportComment.ts`). No second copy of a rule, and no request of its own.
   *
   * Instagram's, measured on the Mi 9T (docs/wiki/frontend/modules/reels.md, "Instagram
   * reference"): about 60 % of the screen, large top corners, a grabber, the composer docked at the
   * bottom. It CLOSES as Instagram's does: a drag down on its top (the grabber and the title), the
   * system Back (a history entry, `bindHistoryOverlay`, so Back closes the sheet before the viewer),
   * a tap on the reel above it, Escape, and the X. Nothing traps the focus: the sheet takes it when
   * it opens and gives it back to the comment button when it closes.
   *
   * THE KEYBOARD: the sheet rides it (`keyboard-aware-bottom`) and is never taller than what the
   * keyboard leaves (`--app-viewport-height`), so the composer stays above the keys.
   */
  import { onMount, tick } from 'svelte';
  import { X } from '@lucide/svelte';
  import PostComments from '$lib/components/posts/PostComments.svelte';
  import ReportReasonDialog from '$lib/components/moderation/ReportReasonDialog.svelte';
  import type { PostComment, PostEntity, PostMediaRef } from '$lib/posts/api';
  import { PostCommentThread, type CommentOutcome } from '$lib/posts/postCommentThread.svelte';
  import type { CommentIdentity } from '$lib/posts/postIdentity';
  import { commentCountOf } from '$lib/posts/commentChange';
  import { reportComment } from '$lib/posts/reportComment';
  import type { ReportReason } from '$lib/moderation/reasons';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import { GESTURE, decideDismiss, releaseVelocity, type Sample } from '$lib/utils/viewerGestures';
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
  }

  let { post, currentUserId, authToken, onChange, onClose }: Props = $props();

  let sheet = $state<HTMLDivElement | null>(null);
  let commentText = $state('');
  /** Why the last comment did not go, said beside the box. */
  let commentError = $state('');
  /** How far the sheet is dragged down, px. */
  let dragY = $state(0);
  let settling = $state(false);
  let afterSettle: (() => void) | null = null;
  let commentBeingReported = $state<PostComment | null>(null);
  let reportSubmitting = $state(false);
  /** Whatever had the focus when the sheet opened - the rail's comment button - to hand it back. */
  let opener: HTMLElement | null = null;

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

  const overlay = bindHistoryOverlay(
    () => true,
    () => {
      console.debug(`[reel-comments] closed on ${post.id}`);
      onClose();
    }
  );

  onMount(() => {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlay.syncOpen();
    console.debug(`[reel-comments] opened on ${post.id}, ${comments.length} comments held`);
    void tick().then(() => sheet?.focus({ preventScroll: true }));
    return () => opener?.focus({ preventScroll: true });
  });

  function reducedMotion(): boolean {
    return (
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  /** Every way out but Back: the history entry goes with it, so Back is not owed twice. */
  function close() {
    overlay.dismissFromUi();
  }

  /** Moves the sheet to `y` with the snap transition, then `then` - at once with reduced motion. */
  function settle(y: number, then?: () => void) {
    if (reducedMotion() || y === dragY) {
      dragY = y;
      settling = false;
      then?.();
      return;
    }
    settling = true;
    afterSettle = then ?? null;
    dragY = y;
  }

  function onTransitionEnd(e: TransitionEvent) {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
    settling = false;
    const next = afterSettle;
    afterSettle = null;
    next?.();
  }

  // THE DRAG DOWN, on the sheet's top only: the list under it scrolls, as Instagram's does (a swipe
  // over its comments scrolled them on the Mi 9T, and did not close it).
  let dragStart: Sample | null = null;
  let samples: Sample[] = [];

  function onHandleDown(e: PointerEvent) {
    if (settling || (e.target as HTMLElement).closest('button')) return;
    dragStart = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    samples = [dragStart];
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onHandleMove(e: PointerEvent) {
    if (!dragStart) return;
    samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (samples.length > 12) samples.shift();
    dragY = Math.max(0, e.clientY - dragStart.y);
  }

  function onHandleUp(e: PointerEvent) {
    if (!dragStart) return;
    samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    const dy = e.clientY - dragStart.y;
    dragStart = null;
    const height = sheet?.clientHeight ?? window.innerHeight;
    const closes = decideDismiss({ dy, velocityY: releaseVelocity(samples).y, height });
    console.debug(
      `[reel-comments] drag released at ${Math.round(dy)} px: ${closes ? 'close' : 'stay'}`
    );
    if (closes) settle(height, close);
    else settle(0);
  }

  function onHandleCancel() {
    dragStart = null;
    settle(0);
  }

  /** Escape closes the sheet, before the viewer reads it (`ReelViewer` stands aside while it is open). */
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented || commentBeingReported) return;
    e.preventDefault();
    close();
  }

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

<svelte:window onkeydown={onKeydown} />

<div class="absolute inset-0 flex flex-col" data-reel-comments>
  <!-- THE REEL ABOVE THE SHEET: still playing, and a tap on it closes the sheet (Instagram's). A
       button, so the viewer's swipe stands aside on it; hidden from assistive tech, which has the X. -->
  <button
    type="button"
    class="min-h-0 flex-1 cursor-default"
    tabindex="-1"
    aria-hidden="true"
    onclick={close}
    data-reel-comments-backdrop
  ></button>

  <div
    bind:this={sheet}
    class="keyboard-aware-bottom bg-cn-surface text-text-main absolute inset-x-0 bottom-0 flex h-[60dvh] max-h-[calc(var(--app-viewport-height,100dvh)-var(--safe-area-inset-top,0px)-3rem)] flex-col rounded-t-3xl pb-[var(--safe-area-inset-bottom,0px)] shadow-2xl outline-none"
    style:transform="translate3d(0, {dragY}px, 0)"
    style:transition={settling
      ? `transform ${GESTURE.SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`
      : 'none'}
    ontransitionend={onTransitionEnd}
    role="dialog"
    aria-modal="false"
    aria-labelledby="reel-comments-title"
    tabindex="-1"
    data-reel-comments-sheet
  >
    <div
      class="flex shrink-0 cursor-grab touch-none flex-col items-center px-2 pt-2 select-none"
      onpointerdown={onHandleDown}
      onpointermove={onHandleMove}
      onpointerup={onHandleUp}
      onpointercancel={onHandleCancel}
      role="presentation"
      data-reel-comments-handle
    >
      <span class="h-1 w-10 rounded-full bg-current opacity-25" aria-hidden="true"></span>
      <div class="grid w-full grid-cols-[2.75rem_1fr_2.75rem] items-center">
        <span></span>
        <h2 id="reel-comments-title" class="text-center text-sm font-bold">
          {m.reels_comments_title()}
        </h2>
        <button
          type="button"
          class="ui-icon-button rounded-full outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-white/10"
          aria-label={m.reels_comments_close()}
          title={m.reels_comments_close()}
          onclick={close}
          data-reel-comments-close
        >
          <X size={20} strokeWidth={2.5} />
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1">
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
    </div>
  </div>
</div>

<ReportReasonDialog
  open={!!commentBeingReported}
  title={m.report_comment_dialog_title()}
  targetPreview={commentBeingReported?.text ?? ''}
  submitting={reportSubmitting}
  onSubmit={submitCommentReport}
  onClose={() => (commentBeingReported = null)}
/>
