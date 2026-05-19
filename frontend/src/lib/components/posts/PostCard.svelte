<script lang="ts">
  import {
    registerEvent,
    votePoll,
    addReaction,
    removeReaction,
    addComment,
    likeComment as likeCommentApi,
    editComment as editCommentApi,
    deleteComment as deleteCommentApi,
    updatePost as updatePostApi,
    deletePost as deletePostApi,
    getPost,
    pinPost as pinPostApi,
    unpinPost as unpinPostApi,
    type PostEntity,
    type PostComment,
  } from '$lib/posts/api';
  import { createReport } from '$lib/moderation/api';
  import { getForm, checkSubmission } from '$lib/forms/api';
  import Card from '$lib/components/ui/Card.svelte';
  import PostHeader from './PostHeader.svelte';
  import PostContent from './PostContent.svelte';
  import PostActions from './PostActions.svelte';
  import ReactionsDisplay from './ReactionsDisplay.svelte';
  import PostPolls from './PostPolls.svelte';
  import PostEventButtons from './PostEventButtons.svelte';
  import PostForms from './PostForms.svelte';
  import PostComments from './PostComments.svelte';
  import PostOverlayControls from './PostOverlayControls.svelte';
  import PostFeedback from './PostFeedback.svelte';
  import { Pin, CalendarCheck } from '@lucide/svelte';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { untrack } from 'svelte';
  import { FORM_CARD_PLACEHOLDER_MIN_HEIGHT } from '$lib/utils/mediaLayout';

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
    /** User's email, pre-filled in event registration payloads. */
    currentUserEmail?: string;
    /** Called after a full list refresh is needed (e.g. after delete from the parent). */
    onRefresh?: () => void;
    /** Called immediately after the post has been deleted so the parent can remove the card. */
    onDelete?: () => void;
  }

  const REACTIONS = [
    { type: "J'aime", emoji: '❤️', icon: 'heart' },
    { type: "J'adore", emoji: '😍', icon: 'love' },
    { type: 'Rire', emoji: '😂', icon: 'laugh' },
    { type: 'Triste', emoji: '😢', icon: 'sad' },
    { type: 'Joyeux', emoji: '😊', icon: 'smile' },
    { type: 'Énervé', emoji: '😠', icon: 'angry' },
    { type: 'Canari', emoji: '🐤', icon: 'bird' },
    { type: 'Marteau', emoji: '🔨', icon: 'hammer' },
  ];

  let { post: postProp, currentUserId, authToken = '', currentUserEmail, onRefresh: _onRefresh, onDelete }: Props = $props();

  // Local mutable copy — updated directly after interactions to avoid a full list reload.
  // Re-syncs from postProp whenever the parent explicitly refreshes.
  let localPost = $derived(untrack(() => ({ ...postProp })));

  let actionMessage = $state('');
  let errorMessage = $state('');
  let editingPost = $state(false);
  let editMarkdown = $state('');
  let selectedOptions = $state<string[]>([]);
  // Synchronise selectedOptions depuis les données serveur (postProp est réactif, localPost ne l'est pas).
  $effect(() => {
    const serverVotes = (postProp.polls ?? []).flatMap(
      (p) => p.votesByUser?.[currentUserId] ?? []
    );
    if (serverVotes.length > 0) {
      selectedOptions = serverVotes;
    }
  });
  let commentText = $state('');
  let showComments = $state(false);
  let submittingComment = $state(false);
  let showReactionPicker = $state(false);

  const isOwnPost = $derived(
    !localPost.association && localPost.authorId === currentUserId
  );

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

  let formInfos = $state<{ id: string; title: string; submitted: boolean; opensAt?: string | null }[]>([]);

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
  let btnFormInfos = $state<Record<string, { formId: string; title: string; submitted: boolean }>>(
    {}
  );

  // Auto-clear des messages d'erreur après 4 secondes
  $effect(() => {
    if (errorMessage) {
      const timer = setTimeout(() => {
        errorMessage = '';
      }, 4000);
      return () => clearTimeout(timer);
    }
  });

  // Auto-clear des messages de succès après 4 secondes
  $effect(() => {
    if (actionMessage) {
      const timer = setTimeout(() => {
        actionMessage = '';
      }, 4000);
      return () => clearTimeout(timer);
    }
  });

  $effect(() => {
    for (const btn of localPost.eventButtons ?? []) {
      if (btn.formId && !btnFormInfos[btn.id]) {
        getForm(btn.formId)
          .then((f) => {
            checkSubmission(f.id)
              .then(({ hasSubmitted }) => {
                btnFormInfos = {
                  ...btnFormInfos,
                  [btn.id]: { formId: f.id, title: f.title, submitted: hasSubmitted },
                };
              })
              .catch(() => {
                btnFormInfos = {
                  ...btnFormInfos,
                  [btn.id]: { formId: f.id, title: f.title, submitted: false },
                };
              });
          })
          .catch((e) => console.error('Failed to load event button form', e));
      }
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
      errorMessage = 'Identifiez-vous avant de voter.';
      return;
    }
    if (!allowEmpty && selectedOptions.length === 0) {
      errorMessage = 'Sélectionnez au moins une option.';
      return;
    }
    try {
      await votePoll(localPost.id, pollId, { optionIds: selectedOptions });
      actionMessage = selectedOptions.length === 0 ? 'Vote retiré.' : 'Vote enregistré !';
      // Update the poll locally — track votesByUser + per-option vote arrays
      const updatedPolls = (localPost.polls ?? []).map((p) => {
        if (p.id !== pollId) return p;
        const newVotesByUser = { ...(p.votesByUser ?? {}), [currentUserId]: selectedOptions };
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
      errorMessage = err instanceof Error ? err.message : 'Impossible de voter';
    }
  }

  /** Toggles a reaction on the post with an optimistic update. Rolls back the local state if the API call fails. */
  async function handleReaction(reactionType: string) {
    if (!currentUserId.trim()) return;

    // Optimistic update — apply immediately, roll back on error
    const prevReactions = { ...(localPost.reactions ?? {}) };
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
      localPost = { ...localPost, reactions: prevReactions };
      errorMessage = err instanceof Error ? err.message : 'Erreur lors de la réaction';
    }
  }

  /** Enters inline edit mode, pre-populating the textarea with the current markdown. */
  function startEditPost() {
    editMarkdown = localPost.markdown ?? '';
    editingPost = true;
  }

  /** Sends the edited markdown to the API and merges the returned post into localPost on success. */
  async function submitEditPost() {
    const text = editMarkdown.trim();
    if (!text) return;
    try {
      const updated = await updatePostApi(localPost.id, text);
      localPost = { ...localPost, ...updated };
      editingPost = false;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Impossible de modifier le post';
    }
  }

  /** Deletes the post via the API and calls onDelete so the parent can remove the card from the list. */
  async function handleDeletePost() {
    try {
      await deletePostApi(localPost.id);
      onDelete?.();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Impossible de supprimer le post';
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
  async function handleAddComment(parentId?: string, media?: import('$lib/posts/api').PostImageRef) {
    const text = commentText.trim();
    if (!text && !media) return;
    if (!currentUserId.trim()) return;
    submittingComment = true;
    try {
      const result = await addComment(localPost.id, { text, parentId, media });
      localPost = { ...localPost, comments: [...(localPost.comments ?? []), result.comment] };
      commentText = '';
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Impossible de commenter';
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
      errorMessage = err instanceof Error ? err.message : 'Impossible de modifier le commentaire';
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
      errorMessage = err instanceof Error ? err.message : 'Impossible de supprimer le commentaire';
    }
  }

  /** Pins or unpins the post (admin only) and updates the local pinned flag on success. */
  async function togglePin() {
    try {
      const fn = localPost.pinned ? unpinPostApi : pinPostApi;
      const res = await fn(localPost.id);
      localPost = { ...localPost, pinned: res.pinned };
      actionMessage = res.pinned ? 'Post épinglé !' : 'Post désépinglé.';
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : "Impossible de modifier l'épingle";
    }
  }

  const REPORT_REASONS = [
    { label: 'Spam', value: 'spam' as const },
    { label: 'Harcèlement', value: 'harassment' as const },
    { label: 'Contenu inapproprié', value: 'inappropriate' as const },
    { label: 'Autre', value: 'other' as const },
  ];
  let reportOpen = $state(false);
  let reportReason = $state('');
  let reportSubmitting = $state(false);

  /** Reports a comment directly with reason 'inappropriate'. */
  async function handleReportComment(commentId: string) {
    try {
      await createReport('comment', commentId, 'inappropriate');
      actionMessage = 'Commentaire signalé. Merci !';
    } catch {
      // Ignore duplicate report errors silently.
    }
  }

  /** Submits the selected report reason via the moderation API. */
  async function submitReport() {
    if (!reportReason) return;
    reportSubmitting = true;
    try {
      const value = REPORT_REASONS.find((r) => r.label === reportReason)?.value ?? 'other';
      await createReport('post', localPost.id, value);
      actionMessage = 'Signalement envoyé. Merci !';
      reportOpen = false;
      reportReason = '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      actionMessage = msg.includes('already') ? 'Vous avez déjà signalé ce post.' : '';
      if (!actionMessage) errorMessage = msg || 'Impossible de signaler';
      reportOpen = false;
      reportReason = '';
    } finally {
      reportSubmitting = false;
    }
  }

  /** Registers the current user for an event button. Redirects to Stripe Checkout if payment is required. */
  async function registerForEvent(buttonId: string) {
    if (!currentUserId.trim()) {
      errorMessage = 'Identifiez-vous avant de vous inscrire.';
      return;
    }
    try {
      const { eventCheckoutCallbacks } = await import('$lib/utils/stripeCallbacks');
      const response = await registerEvent(localPost.id, buttonId, {
        email: currentUserEmail?.trim() || undefined,
        ...eventCheckoutCallbacks(localPost.id, buttonId),
      });
      if (response.checkoutUrl) {
        const { navigateExternal } = await import('$lib/utils/openExternal');
        await navigateExternal(response.checkoutUrl);
      }
      actionMessage =
        response.message ||
        (response.checkoutUrl ? 'Redirection vers le paiement...' : 'Inscription confirmée !');
      if (response.registered) {
        localPost = {
          ...localPost,
          eventButtons: (localPost.eventButtons ?? []).map((btn) =>
            btn.id === buttonId
              ? { ...btn, registrants: [...(btn.registrants ?? []), currentUserId] }
              : btn
          ),
        };
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Impossible de s\u2019inscrire';
    }
  }
</script>

<div class="relative mb-6">
  {#if localPost.pinned}
    <span class="absolute -top-2 left-4 z-10 text-[0.6rem] font-extrabold uppercase tracking-widest bg-amber-500 text-[#151B2C] px-2 py-0.5 rounded-full shadow-md shadow-amber-500/30 inline-flex items-center gap-1 pointer-events-none">
      <Pin size={10} strokeWidth={3} /> Épinglé
    </span>
  {/if}
<Card
  class="group/card !p-0 transition-all duration-300 hover:shadow-xl hover:-translate-y-0.5 border border-black/5 dark:border-white/10 bg-white/70 dark:bg-[#151B2C]/70 backdrop-blur-xl"
>
  <div class="relative">
    <PostHeader post={localPost} />
    <PostOverlayControls
      pinned={localPost.pinned ?? false}
      {isOwnPost}
      isGlobalAdmin={isGlobalAdmin()}
      isLoggedIn={!!currentUserId}
      {reportOpen}
      {reportReason}
      {reportSubmitting}
      reportReasons={REPORT_REASONS.map((r) => r.label)}
      onTogglePin={togglePin}
      onStartEdit={startEditPost}
      onDelete={handleDeletePost}
      onToggleReport={(open) => { reportOpen = open; if (!open) reportReason = ''; }}
      onReportReasonChange={(r) => { reportReason = r; }}
      onSubmitReport={submitReport}
    />
  </div>

  {#if localPost.linkedCalendarEvent}
    {@const ev = localPost.linkedCalendarEvent}
    <div class="px-5 pb-3">
      <a
        href="/associations/{encodeURIComponent(ev.associationSlug)}?section=agenda"
        class="inline-flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-800 dark:text-amber-300 hover:bg-amber-500/20 transition-colors"
      >
        <CalendarCheck size={14} strokeWidth={2.5} />
        <span>
          Événement :
          {ev.title}
          ·
          {new Date(ev.startsAt).toLocaleString('fr-FR', {
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
    <div class="px-5 pb-4 flex flex-col gap-2">
      <textarea
        bind:value={editMarkdown}
        rows={4}
        class="w-full bg-black/5 dark:bg-white/5 rounded-xl px-3 py-2.5 text-[0.9rem] text-text-main border border-black/10 dark:border-white/10 focus:ring-2 focus:ring-amber-500/50 outline-none resize-none"
      ></textarea>
      <div class="flex gap-2 justify-end">
        <button
          type="button"
          onclick={() => (editingPost = false)}
          class="px-3 py-1.5 text-xs font-bold text-text-muted hover:text-text-main rounded-lg transition-colors"
        >Annuler</button>
        <button
          type="button"
          onclick={submitEditPost}
          class="px-4 py-1.5 text-xs font-extrabold bg-amber-500 text-[#151B2C] rounded-lg hover:bg-amber-400 transition-colors"
        >Enregistrer</button>
      </div>
    </div>
  {:else}
    <PostContent post={localPost} {authToken} />
  {/if}

  <PostActions
    {userReaction}
    {showReactionPicker}
    reactionList={REACTIONS}
    commentCount={comments.length || undefined}
    onToggleReactionPicker={() => (showReactionPicker = !showReactionPicker)}
    onReactionSelect={handleReaction}
    onCommentClick={() => (showComments = !showComments)}
  />

  <ReactionsDisplay
    {reactionCounts}
    reactions={localPost.reactions ?? {}}
    {userReaction}
    reactionList={REACTIONS}
    onReactionClick={handleReaction}
  />

  <PostPolls
    polls={localPost.polls}
    {selectedOptions}
    onVoteClick={handleVoteClick}
    onSubmitVote={submitVote}
  />

  <PostEventButtons
    eventButtons={localPost.eventButtons}
    {currentUserId}
    {btnFormInfos}
    onRegisterEvent={registerForEvent}
  />

  {#if pendingAttachedFormIds.length > 0}
    <div class="px-5 py-3 space-y-3" aria-hidden="true">
      {#each pendingAttachedFormIds as formId (formId)}
        <div
          class="rounded-2xl border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/5 animate-pulse"
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

  <!-- Notifications intégrées à la carte -->
  <PostFeedback {errorMessage} {actionMessage} />
</Card>
</div>
