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
    reportPost as reportPostApi,
    type PostEntity,
    type PostComment,
  } from '$lib/posts/api';
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
  import { CircleAlert, CircleCheck, Pencil, Trash2, Flag, Pin, PinOff } from 'lucide-svelte';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { slide, fade } from 'svelte/transition';
  import { untrack } from 'svelte';

  interface Props {
    post: PostEntity;
    currentUserId: string;
    authToken?: string;
    currentUserEmail?: string;
    onRefresh?: () => void;
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

  let { post: postProp, currentUserId, authToken = '', currentUserEmail, onRefresh, onDelete }: Props = $props();

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

  let formInfos = $state<{ id: string; title: string; submitted: boolean }[]>([]);
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
      const doCheck = (id: string, title: string) => {
        checkSubmission(id)
          .then(({ hasSubmitted }) => {
            formInfos = [...formInfos, { id, title, submitted: hasSubmitted }];
          })
          .catch(() => {
            formInfos = [...formInfos, { id, title, submitted: false }];
          });
      };
      if (src.title) {
        doCheck(src.id, src.title);
      } else {
        getForm(src.id)
          .then((f) => doCheck(f.id, f.title))
          .catch((e) => console.error('Failed to load attached form', e));
      }
    }
  });

  function toggleOption(pollId: string, optionId: string, multipleChoice: boolean) {
    if (!multipleChoice) {
      selectedOptions = [optionId];
      return;
    }
    if (selectedOptions.includes(optionId)) {
      selectedOptions = selectedOptions.filter((id) => id !== optionId);
    } else {
      selectedOptions = [...selectedOptions, optionId];
    }
  }

  async function submitVote(pollId: string) {
    if (!currentUserId.trim()) {
      errorMessage = 'Identifiez-vous avant de voter.';
      return;
    }
    if (selectedOptions.length === 0) {
      errorMessage = 'Sélectionnez au moins une option.';
      return;
    }
    try {
      await votePoll(localPost.id, pollId, { optionIds: selectedOptions });
      actionMessage = 'Vote enregistré !';
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

  function startEditPost() {
    editMarkdown = localPost.markdown ?? '';
    editingPost = true;
  }

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

  async function handleDeletePost() {
    try {
      await deletePostApi(localPost.id);
      onDelete?.();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Impossible de supprimer le post';
    }
  }

  async function loadAllComments() {
    try {
      const full = await getPost(localPost.id);
      localPost = { ...localPost, comments: full.comments };
    } catch {
      // silent
    }
  }

  async function handleAddComment(parentId?: string) {
    const text = commentText.trim();
    if (!text || !currentUserId.trim()) return;
    submittingComment = true;
    try {
      const result = await addComment(localPost.id, { text, parentId });
      localPost = { ...localPost, comments: [...(localPost.comments ?? []), result.comment] };
      commentText = '';
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Impossible de commenter';
    } finally {
      submittingComment = false;
    }
  }

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

  const REPORT_REASONS = ['Contenu inapproprié', 'Spam', 'Harcèlement', 'Désinformation', 'Autre'];
  let reportOpen = $state(false);
  let reportReason = $state('');
  let reportSubmitting = $state(false);

  async function submitReport() {
    if (!reportReason) return;
    reportSubmitting = true;
    try {
      const res = await reportPostApi(localPost.id, reportReason);
      actionMessage = res.alreadyReported ? 'Vous avez déjà signalé ce post.' : 'Signalement envoyé. Merci !';
      reportOpen = false;
      reportReason = '';
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Impossible de signaler';
    } finally {
      reportSubmitting = false;
    }
  }

  async function registerForEvent(buttonId: string) {
    if (!currentUserId.trim()) {
      errorMessage = 'Identifiez-vous avant de vous inscrire.';
      return;
    }
    try {
      const response = await registerEvent(localPost.id, buttonId, {
        email: currentUserEmail?.trim() || undefined,
      });
      if (response.checkoutUrl) {
        if ((window as any).__TAURI_INTERNALS__) {
          window.location.href = response.checkoutUrl;
        } else {
          window.open(response.checkoutUrl, '_blank', 'noopener,noreferrer');
        }
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

<Card
  class="group/card mb-6 overflow-hidden !p-0 transition-all duration-300 hover:shadow-xl hover:-translate-y-0.5 border border-black/5 dark:border-white/10 bg-white/70 dark:bg-[#151B2C]/70 backdrop-blur-xl"
>
  <div class="relative">
    <PostHeader post={localPost} />
    {#if localPost.pinned}
      <span class="absolute top-3 left-3 flex items-center gap-1 text-[0.6rem] font-extrabold uppercase tracking-widest text-amber-600 dark:text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">
        <Pin size={10} strokeWidth={3} /> Épinglé
      </span>
    {/if}
    {#if isOwnPost || isGlobalAdmin()}
      <div class="absolute top-3 right-3 flex items-center gap-1">
        {#if isGlobalAdmin()}
          <button
            type="button"
            onclick={togglePin}
            class="p-1.5 rounded-lg text-text-muted hover:text-amber-500 hover:bg-amber-500/10 transition-colors outline-none"
            aria-label={localPost.pinned ? 'Désépingler' : 'Épingler'}
            title={localPost.pinned ? 'Désépingler' : 'Épingler'}
          >
            {#if localPost.pinned}
              <PinOff size={14} strokeWidth={2.5} />
            {:else}
              <Pin size={14} strokeWidth={2.5} />
            {/if}
          </button>
        {/if}
        {#if isOwnPost}
          <button
            type="button"
            onclick={startEditPost}
            class="p-1.5 rounded-lg text-text-muted hover:text-amber-500 hover:bg-amber-500/10 transition-colors outline-none"
            aria-label="Modifier le post"
          >
            <Pencil size={14} strokeWidth={2.5} />
          </button>
          <button
            type="button"
            onclick={handleDeletePost}
            class="p-1.5 rounded-lg text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors outline-none"
            aria-label="Supprimer le post"
          >
            <Trash2 size={14} strokeWidth={2.5} />
          </button>
        {/if}
      </div>
    {:else if currentUserId}
      <div class="absolute top-3 right-3">
        {#if reportOpen}
          <div class="flex flex-col gap-2 bg-white dark:bg-[#1a2236] border border-cn-border rounded-xl p-3 shadow-lg w-52 z-20" transition:slide={{ duration: 150 }}>
            <p class="text-[0.65rem] font-bold text-text-muted uppercase tracking-wide">Signaler ce post</p>
            <div class="flex flex-col gap-1">
              {#each REPORT_REASONS as r (r)}
                <label class="flex items-center gap-2 text-sm cursor-pointer hover:text-text-main transition-colors">
                  <input type="radio" bind:group={reportReason} value={r} class="accent-amber-500 shrink-0" />
                  <span class="text-[0.82rem]">{r}</span>
                </label>
              {/each}
            </div>
            <div class="flex gap-2 mt-1">
              <button type="button" onclick={() => { reportOpen = false; reportReason = ''; }} class="flex-1 text-xs font-bold text-text-muted hover:text-text-main rounded-lg py-1.5 transition-colors">Annuler</button>
              <button type="button" onclick={submitReport} disabled={!reportReason || reportSubmitting} class="flex-1 text-xs font-bold bg-red-500 text-white rounded-lg py-1.5 disabled:opacity-40 transition-colors hover:bg-red-400">Signaler</button>
            </div>
          </div>
        {:else}
          <button
            type="button"
            onclick={() => { reportOpen = true; }}
            class="p-1.5 rounded-lg text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors outline-none opacity-0 group-hover/card:opacity-100"
            aria-label="Signaler ce post"
          >
            <Flag size={14} strokeWidth={2.5} />
          </button>
        {/if}
      </div>
    {/if}
  </div>

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
    onToggleOption={toggleOption}
    onSubmitVote={submitVote}
  />

  <PostEventButtons
    eventButtons={localPost.eventButtons}
    {currentUserId}
    {btnFormInfos}
    onRegisterEvent={registerForEvent}
  />

  <PostForms {formInfos} />

  <PostComments
    {comments}
    {topLevelComments}
    {showComments}
    {commentText}
    {submittingComment}
    {currentUserId}
    onToggleComments={() => (showComments = !showComments)}
    onCommentTextChange={async (text) => {
      commentText = text;
    }}
    onAddComment={handleAddComment}
    onLikeComment={handleLikeComment}
    onEditComment={handleEditComment}
    onDeleteComment={handleDeleteComment}
    onLoadAllComments={loadAllComments}
    totalCommentCount={(localPost.comments ?? []).length}
  />

  <!-- Notifications intégrées à la carte -->
  {#if errorMessage || actionMessage}
    <div class="px-5 pb-5 pt-2">
      {#if errorMessage}
        <div
          transition:slide={{ duration: 200 }}
          class="flex items-start gap-3 p-3.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 shadow-inner"
        >
          <div transition:fade={{ duration: 150 }} class="flex items-center gap-3">
            <CircleAlert size={18} class="shrink-0 mt-0.5" />
            <span class="text-sm font-bold leading-snug">{errorMessage}</span>
          </div>
        </div>
      {/if}

      {#if actionMessage}
        <div
          transition:slide={{ duration: 200 }}
          class="flex items-start gap-3 p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-400 shadow-inner mt-2"
        >
          <div transition:fade={{ duration: 150 }} class="flex items-center gap-3">
            <CircleCheck size={18} class="shrink-0 mt-0.5" />
            <span class="text-sm font-bold leading-snug">{actionMessage}</span>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</Card>
