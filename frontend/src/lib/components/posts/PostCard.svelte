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

  interface Props {
    post: PostEntity;
    currentUserId: string;
    authToken?: string;
    currentUserEmail?: string;
    onRefresh: () => void;
  }

  const REACTIONS = [
    { type: "J'aime", emoji: '❤️', icon: 'heart' },
    { type: "J'adore", emoji: '😍', icon: 'love' },
    { type: 'Triste', emoji: '😢', icon: 'sad' },
    { type: 'Joyeux', emoji: '😊', icon: 'smile' },
    { type: 'Enervé', emoji: '😠', icon: 'angry' },
    { type: 'Canari', emoji: '🐤', icon: 'bird' },
    { type: 'Marteau', emoji: '🔨', icon: 'hammer' },
  ];

  let { post, currentUserId, authToken = '', currentUserEmail, onRefresh }: Props = $props();

  let actionMessage = $state('');
  let errorMessage = $state('');
  let selectedOptions = $state<string[]>([]);
  let commentText = $state('');
  let showComments = $state(false);
  let submittingComment = $state(false);
  let showReactionPicker = $state(false);

  let userReaction = $derived((post.reactions ?? {})[currentUserId] ?? null);
  let reactions = $derived<Record<string, number>>((post.reactions ?? {}) as any);
  let reactionCounts = $derived.by(() => {
    const counts: Record<string, number> = {};
    for (const [, reactionType] of Object.entries(reactions)) {
      counts[reactionType] = (counts[reactionType] ?? 0) + 1;
    }
    return counts;
  });
  let comments = $derived<PostComment[]>(post.comments ?? []);
  let topLevelComments = $derived(comments.filter((c) => !c.parentId));

  let formInfos = $state<{ id: string; title: string; submitted: boolean }[]>([]);
  let btnFormInfos = $state<Record<string, { formId: string; title: string; submitted: boolean }>>(
    {}
  );

  $effect(() => {
    for (const btn of post.eventButtons ?? []) {
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
    if (post.forms && post.forms.length > 0) {
      for (const f of post.forms) formSources.push({ id: f.id, title: f.title });
    } else if (post.attachedFormId) {
      formSources.push({ id: post.attachedFormId });
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
      await votePoll(post.id, pollId, { optionIds: selectedOptions });
      actionMessage = 'Vote enregistré !';
      selectedOptions = [];
      onRefresh();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Impossible de voter';
    }
  }

  async function handleReaction(reactionType: string) {
    if (!currentUserId.trim()) return;
    try {
      if (userReaction === reactionType) {
        await removeReaction(post.id);
      } else {
        await addReaction(post.id, reactionType);
      }
      showReactionPicker = false;
      onRefresh();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Erreur';
    }
  }

  async function handleAddComment() {
    const text = commentText.trim();
    if (!text || !currentUserId.trim()) return;
    submittingComment = true;
    try {
      await addComment(post.id, { text });
      commentText = '';
      onRefresh();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Impossible de commenter';
    } finally {
      submittingComment = false;
    }
  }

  async function handleLikeComment(commentId: string) {
    try {
      await likeCommentApi(post.id, commentId);
      onRefresh();
    } catch {
      // ignore
    }
  }

  async function registerForEvent(buttonId: string) {
    if (!currentUserId.trim()) {
      errorMessage = 'Identifiez-vous avant de vous inscrire.';
      return;
    }
    try {
      const response = await registerEvent(post.id, buttonId, {
        email: currentUserEmail?.trim() || undefined,
      });
      if (response.checkoutUrl) {
        window.open(response.checkoutUrl, '_blank', 'noopener,noreferrer');
      }
      actionMessage =
        response.message ||
        (response.checkoutUrl ? 'Redirection vers le paiement...' : 'Inscription confirmée !');
      onRefresh();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Impossible de s\u2019inscrire';
    }
  }
</script>

<Card class="mb-6 overflow-hidden !p-0 hover:shadow-lg transition-shadow">
  <PostHeader {post} />
  <PostContent {post} {authToken} />
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
    polls={post.polls}
    {selectedOptions}
    onToggleOption={toggleOption}
    onSubmitVote={submitVote}
  />
  <PostEventButtons
    eventButtons={post.eventButtons}
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
    onKeyDown={(e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleAddComment();
      }
    }}
  />

  {#if errorMessage}
    <div
      class="mx-5 mb-4 p-3 rounded-xl bg-red-err/10 text-red-err text-sm font-medium border border-red-err/20"
    >
      {errorMessage}
    </div>
  {/if}
  {#if actionMessage}
    <div
      class="mx-5 mb-4 p-3 rounded-xl bg-green-ok/10 text-green-ok text-sm font-medium border border-green-ok/20"
    >
      {actionMessage}
    </div>
  {/if}
</Card>
