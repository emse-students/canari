<script lang="ts">
  import {
    votePoll,
    addReaction,
    removeReaction,
    addComment,
    likeComment as likeCommentApi,
    editComment as editCommentApi,
    deleteComment as deleteCommentApi,
    deletePost as deletePostApi,
    getPost,
    pinPost as pinPostApi,
    unpinPost as unpinPostApi,
    type PostEntity,
    type PostComment,
  } from '$lib/posts/api';
  import { Log } from '$lib/utils/Log';
  import { createReport, ModerationApiError } from '$lib/moderation/api';
  import type { ReportReason } from '$lib/moderation/reasons';
  import ReportReasonDialog from '$lib/components/moderation/ReportReasonDialog.svelte';
  import { assertNotMuted } from '$lib/moderation/muteCheck';
  import { getForm, checkSubmission } from '$lib/forms/api';
  import Card from '$lib/components/ui/Card.svelte';
  import PostHeader from './PostHeader.svelte';
  import PostContent from './PostContent.svelte';
  import PostActions from './PostActions.svelte';
  import ReactionsDisplay from './ReactionsDisplay.svelte';
  import PostPolls from './PostPolls.svelte';
  import PostForms from './PostForms.svelte';
  import PostComments from './PostComments.svelte';
  import PostActionsMenu from './PostActionsMenu.svelte';
  import PostFeedback from './PostFeedback.svelte';
  import EditPostForm from './EditPostForm.svelte';
  import { Pin, CalendarCheck } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import { FORM_CARD_PLACEHOLDER_MIN_HEIGHT } from '$lib/utils/mediaLayout';
  import { REACTIONS } from '$lib/posts/reactions';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  /**
   * Props for the PostCard component.
   * The card is self-contained: it manages its own local copy of the post
   * and updates it optimistically after each user interaction.
   */
  interface Props {
    /** The post data to render. The card keeps a local copy and does NOT auto-sync on prop changes. */
    post: PostEntity;
    /** ID of the authenticated user, used to gate edit/delete/reaction controls. */
    currentUserId: string;
    /** Bearer token forwarded to media URLs that require auth. */
    authToken?: string;
    /** Called after a full list refresh is needed (e.g. after delete from the parent). */
    onRefresh?: () => void;
    /** Called immediately after the post has been deleted so the parent can remove the card. */
    onDelete?: () => void;
    /**
     * Whether the comment section starts open.
     *
     * FALSE IN A FEED, TRUE ON A POST'S OWN PAGE, and the distinction is the reader's intent. The
     * composer is no longer drawn at rest (it cost 90 px in every card, see `PostComments`), so a
     * card that starts closed shows none - correct for a feed being scrolled past, wrong for
     * `/posts/[postId]`, which a reader reached by following a link to THAT post and where the
     * comments are most of what they came for. Facebook opens the section on a post's own page for
     * the same reason.
     */
    commentsOpen?: boolean;
  }

  let {
    post: postProp,
    currentUserId,
    authToken = '',
    onRefresh: _onRefresh,
    onDelete,
    commentsOpen = false,
  }: Props = $props();

  // Local mutable copy - updated directly after interactions to avoid a full list reload.
  // Re-syncs from postProp whenever the parent explicitly refreshes.
  let localPost = $derived(untrack(() => ({ ...postProp })));

  let actionMessage = $state('');
  let errorMessage = $state('');
  let editingPost = $state(false);
  let selectedOptions = $state<string[]>([]);
  // Sync selectedOptions from server data (postProp is reactive; localPost is not).
  $effect(() => {
    const serverVotes = (postProp.polls ?? []).flatMap((p) => p.votesByUser?.[currentUserId] ?? []);
    if (serverVotes.length > 0) {
      selectedOptions = serverVotes;
    }
  });
  let commentText = $state('');
  // `untrack` states what the prop IS: an initial value, read once. The card owns the open/closed
  // state from then on - a parent that flipped the prop later would otherwise fight the reader's
  // own taps on the comment button.
  let showComments = $state(untrack(() => commentsOpen));
  let submittingComment = $state(false);
  let showReactionPicker = $state(false);

  // Server-answered, per reader and per control. Never re-derived here: an association post carries
  // no `authorId` to compare against, and nothing in a post says whether its reader moderates.
  const canManage = $derived(localPost.canManage === true);
  const canPin = $derived(localPost.canPin === true);
  const canReport = $derived(localPost.canReport === true);

  let userReaction = $derived((localPost.reactions ?? {})[currentUserId] ?? null);
  let reactions = $derived<Record<string, number>>((localPost.reactions ?? {}) as any);
  let reactionCounts = $derived.by(() => {
    const counts: Record<string, number> = {};
    for (const [, reactionType] of Object.entries(reactions)) {
      counts[reactionType] = (counts[reactionType] ?? 0) + 1;
    }
    return counts;
  });
  let comments = $derived<PostComment[]>(localPost.comments ?? []);
  let topLevelComments = $derived(comments.filter((c) => !c.parentId));

  let formInfos = $state<
    { id: string; title: string; submitted: boolean; opensAt?: string | null }[]
  >([]);

  const expectedAttachedFormIds = $derived.by(() => {
    const ids: string[] = [];
    if (localPost.forms?.length) {
      for (const f of localPost.forms) ids.push(f.id);
    } else if (localPost.attachedFormId) {
      ids.push(localPost.attachedFormId);
    }
    return ids;
  });

  const pendingAttachedFormIds = $derived(
    expectedAttachedFormIds.filter((id) => !formInfos.some((fi) => fi.id === id))
  );
  // Auto-clear error messages after 4 seconds.
  $effect(() => {
    if (errorMessage) {
      const timer = setTimeout(() => {
        errorMessage = '';
      }, 4000);
      return () => clearTimeout(timer);
    }
  });

  // Auto-clear success messages after 4 seconds.
  $effect(() => {
    if (actionMessage) {
      const timer = setTimeout(() => {
        actionMessage = '';
      }, 4000);
      return () => clearTimeout(timer);
    }
  });

  $effect(() => {
    const formSources: { id: string; title?: string }[] = [];
    if (localPost.forms && localPost.forms.length > 0) {
      for (const f of localPost.forms) formSources.push({ id: f.id, title: f.title });
    } else if (localPost.attachedFormId) {
      formSources.push({ id: localPost.attachedFormId });
    }

    for (const src of formSources) {
      if (formInfos.find((fi) => fi.id === src.id)) continue;
      const doCheck = (id: string, title: string, opensAt?: string | null) => {
        checkSubmission(id)
          .then(({ hasSubmitted }) => {
            formInfos = [...formInfos, { id, title, submitted: hasSubmitted, opensAt }];
          })
          .catch(() => {
            formInfos = [...formInfos, { id, title, submitted: false, opensAt }];
          });
      };
      if (src.title) {
        doCheck(src.id, src.title);
      } else {
        getForm(src.id)
          .then((f) => doCheck(f.id, f.title, f.opensAt))
          .catch((e) => console.error('Failed to load attached form', e));
      }
    }
  });

  /**
   * Handles a click on a poll option.
   * Single-choice: toggles the selection and immediately submits (click = vote, click again = remove).
   * Multiple-choice: toggles selection only; user submits manually with the "Voter" button.
   */
  function handleVoteClick(pollId: string, optionId: string, multipleChoice: boolean) {
    if (!multipleChoice) {
      selectedOptions = selectedOptions.includes(optionId) ? [] : [optionId];
      void submitVote(pollId, true);
    } else {
      if (selectedOptions.includes(optionId)) {
        selectedOptions = selectedOptions.filter((id) => id !== optionId);
      } else {
        selectedOptions = [...selectedOptions, optionId];
      }
    }
  }

  /** Submits the current selectedOptions to the API and updates the local poll vote counts on success. */
  async function submitVote(pollId: string, allowEmpty = false) {
    if (!currentUserId.trim()) {
      errorMessage = m.post_identifier_avant();
      return;
    }
    if (!allowEmpty && selectedOptions.length === 0) {
      errorMessage = m.post_sondage_selectionner();
      return;
    }
    try {
      await votePoll(localPost.id, pollId, { optionIds: selectedOptions });
      actionMessage =
        selectedOptions.length === 0 ? m.post_vote_retire() : m.post_vote_enregistre();
      // Update the poll locally - track votesByUser + per-option vote arrays
      const updatedPolls = (localPost.polls ?? []).map((p) => {
        if (p.id !== pollId) return p;
        const newVotesByUser = { ...p.votesByUser, [currentUserId]: selectedOptions };
        const newOptions = (p.options ?? []).map((opt: any) => {
          const votes = Array.isArray(opt.votes) ? opt.votes : [];
          const hadVote = votes.includes(currentUserId);
          const hasVote = selectedOptions.includes(opt.id);
          if (hadVote && !hasVote)
            return { ...opt, votes: votes.filter((v: string) => v !== currentUserId) };
          if (!hadVote && hasVote) return { ...opt, votes: [...votes, currentUserId] };
          return opt;
        });
        return { ...p, votesByUser: newVotesByUser, options: newOptions };
      });
      localPost = { ...localPost, polls: updatedPolls };
    } catch (err) {
      Log.d('PostCard.submitVote failed', err);
      errorMessage = m.post_unable_to_vote();
    }
  }

  /** Toggles a reaction on the post with an optimistic update. Rolls back the local state if the API call fails. */
  async function handleReaction(reactionType: string) {
    if (!currentUserId.trim()) return;
    try {
      await assertNotMuted();
    } catch (err) {
      Log.d('handleReaction failed', err);
      errorMessage = m.post_action_not_allowed();
      return;
    }

    // Optimistic update - apply immediately, roll back on error
    const prevReactions = { ...localPost.reactions };
    const wasReacted = prevReactions[currentUserId] === reactionType;
    const newReactions = { ...prevReactions };
    if (wasReacted) delete newReactions[currentUserId];
    else newReactions[currentUserId] = reactionType;
    localPost = { ...localPost, reactions: newReactions };
    showReactionPicker = false;

    try {
      const result = wasReacted
        ? await removeReaction(localPost.id)
        : await addReaction(localPost.id, reactionType);
      localPost = { ...localPost, reactions: result.reactions };
    } catch (err) {
      Log.d('handleReaction failed', err);
      localPost = { ...localPost, reactions: prevReactions };
      errorMessage = m.post_reaction_error();
    }
  }

  /** Enters edit mode (shows EditPostForm in place of PostContent). */
  function startEditPost() {
    editingPost = true;
  }

  /** Called by EditPostForm on successful save; merges the updated post and closes edit mode. */
  function onPostSaved(updated: PostEntity) {
    localPost = { ...localPost, ...updated };
    editingPost = false;
  }

  /** Deletes the post via the API and calls onDelete so the parent can remove the card from the list. */
  async function handleDeletePost() {
    try {
      await deletePostApi(localPost.id);
      onDelete?.();
    } catch (err) {
      Log.d('handleDeletePost failed', err);
      errorMessage = m.post_unable_to_delete_post();
    }
  }

  /** Fetches the full post (with all comments) to replace the truncated comment list returned by the feed endpoint. */
  async function loadAllComments() {
    try {
      const full = await getPost(localPost.id);
      localPost = { ...localPost, comments: full.comments };
    } catch {
      // silent
    }
  }

  /** Posts a new comment (or reply) and appends it to the local comments array. media is an optional encrypted GIF/image ref. */
  async function handleAddComment(
    parentId?: string,
    media?: import('$lib/posts/api').PostMediaRef
  ) {
    const text = commentText.trim();
    if (!text && !media) return;
    if (!currentUserId.trim()) return;
    submittingComment = true;
    try {
      await assertNotMuted();
      const result = await addComment(localPost.id, { text, parentId, media });
      localPost = { ...localPost, comments: [...(localPost.comments ?? []), result.comment] };
      commentText = '';
    } catch (err) {
      Log.d('handleAddComment failed', err);
      errorMessage = m.post_unable_to_comment();
    } finally {
      submittingComment = false;
    }
  }

  /** Toggles a like on a comment and updates the local comment in-place. Fails silently to avoid disrupting UX. */
  async function handleLikeComment(commentId: string) {
    try {
      const result = await likeCommentApi(localPost.id, commentId);
      localPost = {
        ...localPost,
        comments: (localPost.comments ?? []).map((c) => (c.id === commentId ? result.comment : c)),
      };
    } catch {
      // ignore silently to not disrupt UX
    }
  }

  /** Sends the updated comment text to the API and replaces the matching comment in the local list. */
  async function handleEditComment(commentId: string, text: string) {
    try {
      const result = await editCommentApi(localPost.id, commentId, text);
      localPost = {
        ...localPost,
        comments: (localPost.comments ?? []).map((c) => (c.id === commentId ? result.comment : c)),
      };
    } catch (err) {
      Log.d('handleEditComment failed', err);
      errorMessage = m.post_unable_to_edit_comment();
    }
  }

  /** Deletes a comment and all its replies from both the API and the local comments array. */
  async function handleDeleteComment(commentId: string) {
    try {
      await deleteCommentApi(localPost.id, commentId);
      localPost = {
        ...localPost,
        comments: (localPost.comments ?? []).filter(
          (c) => c.id !== commentId && c.parentId !== commentId
        ),
      };
    } catch (err) {
      Log.d('handleDeleteComment failed', err);
      errorMessage = m.post_unable_to_delete_comment();
    }
  }

  /** Pins or unpins the post (admin only) and updates the local pinned flag on success. */
  async function togglePin() {
    try {
      const fn = localPost.pinned ? unpinPostApi : pinPostApi;
      const res = await fn(localPost.id);
      localPost = { ...localPost, pinned: res.pinned };
      actionMessage = res.pinned ? m.post_epingle() : m.post_unpinned();
    } catch (err) {
      Log.d('togglePin failed', err);
      errorMessage = m.post_unable_to_toggle_pin();
    }
  }

  /** Whether the post's own report dialog is open. A comment's is keyed by the comment instead. */
  let reportingPost = $state(false);
  let reportSubmitting = $state(false);

  /** The comment awaiting a reason in the report dialog, or null when the dialog is closed. */
  let commentBeingReported = $state<PostComment | null>(null);

  /**
   * Turns a report refusal into an inline message.
   *
   * The duplicate case is read off the server's `code`, never off its wording - see
   * {@link ModerationApiError}. Anything else is a real failure and is SHOWN: this path used to
   * swallow every error on the comment side, so a moderation outage looked exactly like a
   * successful report to the person filing it.
   */
  function reportFailed(err: unknown, alreadyMessage: string) {
    if (err instanceof ModerationApiError && err.isAlreadyReported) {
      actionMessage = alreadyMessage;
      return;
    }
    Log.d('PostCard.reportFailed', err);
    errorMessage = m.post_unable_to_report();
  }

  /** Opens the reason dialog for a comment. Same four reasons a post offers. */
  function handleReportComment(commentId: string) {
    const comment = (localPost.comments ?? []).find((c) => c.id === commentId) ?? null;
    if (!comment) {
      Log.d('PostCard.handleReportComment', `unknown comment ${commentId}`);
      return;
    }
    commentBeingReported = comment;
  }

  /** Files the report for the comment currently in the dialog. */
  async function submitCommentReport(reason: ReportReason) {
    const comment = commentBeingReported;
    if (!comment) return;
    reportSubmitting = true;
    try {
      await createReport('comment', comment.id, reason, undefined, comment.userId ?? null);
      actionMessage = m.post_comment_reported();
    } catch (err) {
      reportFailed(err, m.post_comment_already_reported());
    } finally {
      reportSubmitting = false;
      commentBeingReported = null;
    }
  }

  /** Submits the chosen reason for the post itself, through the same dialog a comment uses. */
  async function submitReport(reason: ReportReason) {
    reportSubmitting = true;
    try {
      await createReport('post', localPost.id, reason, undefined, localPost.authorId ?? null);
      actionMessage = m.post_signalement_merci();
    } catch (err) {
      reportFailed(err, m.post_already_reported());
    } finally {
      reportingPost = false;
      reportSubmitting = false;
    }
  }
</script>

<div class="relative mb-6">
  <!--
    NO GLOW. The badge carried `shadow-md shadow-amber-500/30` - an amber halo bleeding onto the
    card behind it, and the only one of its kind on this surface. A colour-tinted shadow says
    "this is lit"; every other chip, pill and card here says depth with a neutral shadow or with
    none. One element speaking a different visual language reads as an accident, which is what it
    looked like on the phone.
  -->
  {#if localPost.pinned}
    <span
      class="text-cn-ink text-2xs pointer-events-none absolute -top-2 left-4 z-10 inline-flex items-center gap-1 rounded-full bg-amber-500 px-2 py-0.5 font-bold tracking-widest uppercase"
    >
      <Pin size={10} strokeWidth={3} />
      {m.post_pinned()}
    </span>
  {/if}
  <Card
    class="group/card bg-cn-surface border border-black/5 p-0! transition-all duration-300 hover:-translate-y-0.5 hover:shadow-xl dark:border-white/10"
  >
    <!--
      THE MENU SHARES THE HEADER'S LINE; FIVE BUTTONS USED TO FLOAT OVER IT.
      This was `<div class="relative">` with the action row absolutely positioned `top-3 right-3` on
      top of `PostHeader`, whose name column is `flex-1` and therefore ran the full width of the card
      - underneath the buttons. Measured on A1 (Mi 9T, 436 x 945 CSS px) on 2026-09-14: the share
      icon's box (x 187-201) sat inside the association link "BDE - Bureau des Eleves" (x 83-229),
      14 x 8 px of overlap, on EVERY card in the feed. The `truncate` on that column could not help -
      it truncates at the column's width, and the column extended to the card's edge.

      Laying the row out beside the header instead fixed the overlap and exposed the real defect: the
      five 44 px targets then took 248 px of a 403 px card and the name was cut to "BDE - Bu...". The
      count is what was wrong, so `PostActionsMenu` collapses them into one overflow button and the
      name gets the rest - at every width, for every reader, whether they may do one thing or five.
    -->
    <div class="flex items-start">
      <PostHeader post={localPost} />
      <PostActionsMenu
        pinned={localPost.pinned ?? false}
        {canManage}
        {canPin}
        {canReport}
        isLoggedIn={!!currentUserId}
        onTogglePin={togglePin}
        onStartEdit={startEditPost}
        onDelete={handleDeletePost}
        onReport={() => (reportingPost = true)}
        postId={localPost.id}
      />
    </div>

    {#if localPost.linkedCalendarEvent}
      {@const ev = localPost.linkedCalendarEvent}
      <div class="px-5 pb-3">
        <a
          href="/associations/{encodeURIComponent(ev.associationSlug)}?section=agenda"
          class="inline-flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-800 transition-colors hover:bg-amber-500/20 dark:text-amber-300"
        >
          <CalendarCheck size={14} strokeWidth={2.5} />
          <span>
            {m.post_event_label()}
            {ev.title}
            ·
            {new Date(ev.startsAt).toLocaleString(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </a>
      </div>
    {/if}

    {#if editingPost}
      <div class="px-4 pb-4 sm:px-5">
        <EditPostForm
          post={localPost}
          {authToken}
          onSaved={onPostSaved}
          onCancel={() => (editingPost = false)}
        />
      </div>
    {:else}
      <PostContent post={localPost} {authToken} />
    {/if}

    <!--
      THE TALLY SITS ON THE ACTION BAR, NOT UNDER IT. `ReactionsDisplay` used to be the next sibling
      and drew a second bordered row for it - 65 px of bar plus 49 px of tally on A1, where Facebook
      spends 44 px on both together. Passing it as a snippet keeps its five props here, where the
      post's reaction state already lives, while `PostActions` decides only where it sits.
    -->
    <PostActions
      {userReaction}
      {showReactionPicker}
      reactionList={REACTIONS}
      commentCount={comments.length || undefined}
      onToggleReactionPicker={() => (showReactionPicker = !showReactionPicker)}
      onReactionSelect={handleReaction}
      onCommentClick={() => (showComments = !showComments)}
    >
      {#snippet reactionSummary()}
        <ReactionsDisplay
          {reactionCounts}
          reactions={localPost.reactions ?? {}}
          {userReaction}
          reactionList={REACTIONS}
          onReactionClick={handleReaction}
        />
      {/snippet}
    </PostActions>

    <!--
      A post poll's deadline is a date its author picked, hours or days out, so comparing it to this
      clock is sound - and stating that here is the point: the renderer no longer decides for callers
      whose deadline came from a different clock (see PostPolls.isOver).
    -->
    <PostPolls
      polls={localPost.polls}
      {selectedOptions}
      onVoteClick={handleVoteClick}
      onSubmitVote={submitVote}
      isOver={(poll) => !!poll.endsAt && new Date(poll.endsAt).getTime() <= Date.now()}
    />

    {#if pendingAttachedFormIds.length > 0}
      <div class="space-y-3 px-5 py-3" aria-hidden="true">
        {#each pendingAttachedFormIds as formId (formId)}
          <div
            class="animate-pulse rounded-2xl border border-black/5 bg-black/5 dark:border-white/10 dark:bg-white/5"
            style="min-height: {FORM_CARD_PLACEHOLDER_MIN_HEIGHT}"
          ></div>
        {/each}
      </div>
    {/if}

    <PostForms {formInfos} />

    <PostComments
      {comments}
      {topLevelComments}
      {showComments}
      {commentText}
      {submittingComment}
      {currentUserId}
      {authToken}
      onToggleComments={() => (showComments = !showComments)}
      onCommentTextChange={async (text) => {
        commentText = text;
      }}
      onAddComment={handleAddComment}
      onLikeComment={handleLikeComment}
      onEditComment={handleEditComment}
      onDeleteComment={handleDeleteComment}
      onReport={handleReportComment}
      onLoadAllComments={loadAllComments}
      totalCommentCount={(localPost.comments ?? []).length}
    />

    <!-- Inline card notifications. -->
    <PostFeedback {errorMessage} {actionMessage} />
  </Card>
</div>

<!--
  A comment and a post are reported through the same four reasons AND the same dialog, and until
  2026-09-14 the second half of that sentence was false: the post had its own 52 px-wide popover of
  radio buttons inside the header's action row, a second implementation of everything below.
-->
<ReportReasonDialog
  open={!!commentBeingReported}
  title={m.report_comment_dialog_title()}
  targetPreview={commentBeingReported?.text ?? ''}
  submitting={reportSubmitting}
  onSubmit={submitCommentReport}
  onClose={() => (commentBeingReported = null)}
/>

<ReportReasonDialog
  open={reportingPost}
  title={m.post_report_post_title()}
  targetPreview={localPost.markdown}
  submitting={reportSubmitting}
  onSubmit={submitReport}
  onClose={() => (reportingPost = false)}
/>
