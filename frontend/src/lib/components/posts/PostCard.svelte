<script lang="ts">
  import {
    registerEvent,
    votePoll,
    addReaction,
    removeReaction,
    addComment,
    likeComment as likeCommentApi,
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
  import { CircleAlert, CircleCheck } from 'lucide-svelte';
  import { slide, fade } from 'svelte/transition';
  import { untrack } from 'svelte';

  interface Props {
    post: PostEntity;
    currentUserId: string;
    authToken?: string;
    currentUserEmail?: string;
  }

  const REACTIONS = [
    { type: "J'aime", emoji: '❤️', icon: 'heart' },
    { type: "J'adore", emoji: '😍', icon: 'love' },
    { type: 'Triste', emoji: '😢', icon: 'sad' },
    { type: 'Joyeux', emoji: '😊', icon: 'smile' },
    { type: 'Énervé', emoji: '😠', icon: 'angry' },
    { type: 'Canari', emoji: '🐤', icon: 'bird' },
    { type: 'Marteau', emoji: '🔨', icon: 'hammer' },
  ];

  let { post: postProp, currentUserId, authToken = '', currentUserEmail }: Props = $props();

  // Local mutable copy — updated directly after interactions to avoid a full list reload.
  // Re-syncs from postProp whenever the parent explicitly refreshes.
  let localPost = $derived(untrack(() => ({ ...postProp })));

  let actionMessage = $state('');
  let errorMessage = $state('');
  let selectedOptions = $state<string[]>([]);
  // Synchronise selectedOptions avec les votes serveur à chaque rafraîchissement du post.
  $effect(() => {
    const serverVotes = (localPost.polls ?? []).flatMap(
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
    try {
      let result;
      if (userReaction === reactionType) {
        result = await removeReaction(localPost.id);
      } else {
        result = await addReaction(localPost.id, reactionType);
      }
      localPost = { ...localPost, reactions: result.reactions };
      showReactionPicker = false;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Erreur lors de la réaction';
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
  class="mb-6 overflow-hidden !p-0 transition-all duration-300 hover:shadow-xl hover:-translate-y-0.5 border border-black/5 dark:border-white/10 bg-white/70 dark:bg-[#151B2C]/70 backdrop-blur-xl"
>
  <PostHeader post={localPost} />
  <PostContent post={localPost} {authToken} />

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
