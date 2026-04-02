<script lang="ts">
  import {
    registerEvent,
    votePoll,
    likePost,
    unlikePost,
    addComment,
    likeComment as likeCommentApi,
    type PostEntity,
    type PostComment,
  } from '$lib/posts/api';
  import { getForm, checkSubmission } from '$lib/forms/api';
  import SvelteMarkdown from 'svelte-markdown';
  import PostImage from './PostImage.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import {
    Check,
    ClipboardList,
    ExternalLink,
    Heart,
    MessageCircle,
    Send,
    ChevronDown,
    ChevronUp,
  } from 'lucide-svelte';

  interface Props {
    post: PostEntity;
    currentUserId: string;
    authToken?: string;
    currentUserEmail?: string;
    onRefresh: () => void;
  }

  let { post, currentUserId, authToken = '', currentUserEmail, onRefresh }: Props = $props();

  let actionMessage = $state('');
  let errorMessage = $state('');
  let selectedOptions = $state<string[]>([]);
  let commentText = $state('');
  let showComments = $state(false);
  let submittingComment = $state(false);

  let isLiked = $derived((post.likes ?? []).includes(currentUserId));
  let likesCount = $derived((post.likes ?? []).length);
  let comments = $derived<PostComment[]>(post.comments ?? []);
  let topLevelComments = $derived(comments.filter((c) => !c.parentId));

  function timeAgo(dateStr: string): string {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diffSec = Math.floor((now - then) / 1000);
    if (diffSec < 60) return 'à l\u2019instant';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `il y a ${diffMin} min`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `il y a ${diffH}h`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `il y a ${diffD}j`;
    return new Date(dateStr).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  // Compact form info (just title + submitted status)
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

  async function handleToggleLike() {
    if (!currentUserId.trim()) return;
    try {
      if (isLiked) {
        await unlikePost(post.id);
      } else {
        await likePost(post.id);
      }
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

  function formatCurrency(amountCents: number | undefined, currency = 'eur') {
    if (amountCents === undefined) return '';
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amountCents / 100);
  }
</script>

<Card class="mb-6 overflow-hidden !p-0 hover:shadow-lg transition-shadow">
  <!-- Author header -->
  <div class="flex items-center gap-3 px-5 py-4">
    <div
      class="w-10 h-10 rounded-full bg-gradient-to-br from-cn-yellow/30 to-cn-yellow/10 flex items-center justify-center text-cn-dark font-bold text-sm border border-cn-border/50"
    >
      {(post.authorDisplayName || post.authorId).slice(0, 2).toUpperCase()}
    </div>
    <div class="flex-1 min-w-0">
      <div class="font-bold text-sm text-text-main truncate">
        {post.authorDisplayName || post.authorId}
      </div>
      <div class="text-xs text-text-muted">{timeAgo(post.createdAt)}</div>
    </div>
  </div>

  <!-- Images (full-width like Instagram) -->
  {#if post.images && post.images.length > 0 && authToken}
    <div class="border-y border-cn-border/40">
      {#if post.images.length === 1}
        <PostImage media={post.images[0]} {authToken} />
      {:else}
        <div class="grid grid-cols-2 gap-0.5">
          {#each post.images as img (img.mediaId)}
            <PostImage media={img} {authToken} />
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Action bar (like / comment) -->
  <div class="flex items-center gap-4 px-5 pt-3 pb-1">
    <button
      type="button"
      onclick={handleToggleLike}
      class="flex items-center gap-1.5 transition-colors {isLiked
        ? 'text-red-500'
        : 'text-text-muted hover:text-red-500'}"
      aria-label={isLiked ? 'Ne plus aimer' : 'Aimer'}
    >
      <Heart size={22} fill={isLiked ? 'currentColor' : 'none'} />
    </button>
    <button
      type="button"
      onclick={() => (showComments = !showComments)}
      class="flex items-center gap-1.5 text-text-muted hover:text-text-main transition-colors"
      aria-label="Commenter"
    >
      <MessageCircle size={22} />
    </button>
  </div>

  <!-- Likes count -->
  {#if likesCount > 0}
    <div class="px-5 text-sm font-bold text-text-main">
      {likesCount} J'aime{likesCount > 1 ? '' : ''}
    </div>
  {/if}

  <!-- Markdown content -->
  <div class="px-5 pb-2 pt-1">
    <div class="text-sm text-text-main leading-relaxed">
      <span class="font-bold mr-1">{post.authorDisplayName || post.authorId}</span>
      <span class="prose prose-sm max-w-none inline [&_p]:inline [&_p]:m-0">
        <SvelteMarkdown source={post.markdown} />
      </span>
    </div>
  </div>

  <!-- Polls -->
  {#if post.polls && post.polls.length > 0}
    <div class="px-5 pb-4 space-y-4">
      {#each post.polls as poll (poll.id)}
        <div class="rounded-xl border border-cn-border bg-[var(--cn-surface)]/30 p-4">
          <h4 class="font-bold mb-3 text-base text-text-main">{poll.question}</h4>
          <div class="space-y-2">
            {#each poll.options as option (option.id)}
              {@const isSelected = selectedOptions.includes(option.id)}
              <button
                class="w-full text-left p-3 rounded-xl border-2 transition-all flex justify-between items-center
                {isSelected
                  ? 'border-cn-yellow bg-cn-yellow/5'
                  : 'border-cn-border hover:border-cn-yellow/50 bg-[var(--cn-surface)]'}"
                onclick={() => toggleOption(poll.id, option.id, poll.multipleChoice)}
              >
                <span class="font-medium text-sm">{option.label}</span>
                <span
                  class="text-xs font-mono text-text-muted bg-[var(--cn-bg)] px-2 py-1 rounded-lg"
                >
                  {option.votes} votes
                </span>
              </button>
            {/each}
          </div>
          <div class="mt-3 flex justify-end">
            <Button
              variant="primary"
              class="px-6 !py-2 !text-sm !rounded-xl"
              disabled={selectedOptions.length === 0}
              onclick={() => submitVote(poll.id)}
            >
              Voter
            </Button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Event buttons -->
  {#if post.eventButtons && post.eventButtons.length > 0}
    <div class="px-5 pb-4 space-y-3 border-t border-cn-border/40 pt-4">
      {#each post.eventButtons as btn (btn.id)}
        {@const isRegistered = btn.registrants.includes(currentUserId)}
        {@const isFull = Boolean(btn.capacity && btn.registrants.length >= btn.capacity)}
        {@const btnInfo = btnFormInfos[btn.id]}

        <div class="flex flex-col gap-2">
          {#if btn.formId}
            {#if btnInfo?.submitted}
              <div class="flex items-center gap-2 text-green-ok font-semibold text-sm">
                <Check size={16} />
                <span>{btn.label} — Inscrit</span>
                <a
                  href="/forms/{btn.formId}?redirect=/posts"
                  class="ml-2 text-xs text-text-muted underline hover:text-cn-dark transition-colors"
                >
                  Voir ma réponse
                </a>
              </div>
            {:else}
              <a
                href={isFull ? undefined : `/forms/${btn.formId}?redirect=/posts`}
                class="inline-flex items-center gap-2 rounded-xl border border-cn-border bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-all {isFull
                  ? 'opacity-60 pointer-events-none'
                  : ''}"
              >
                {isFull ? 'Complet' : btn.label}
                {#if btn.requiresPayment && !isFull}
                  <span class="opacity-80">({formatCurrency(btn.amountCents, btn.currency)})</span>
                {/if}
                <ExternalLink size={14} class="opacity-60" />
              </a>
            {/if}
          {:else}
            <div class="flex flex-col items-start gap-2">
              <Button
                variant={isRegistered ? 'ghost' : 'primary'}
                disabled={isRegistered || (isFull && !isRegistered)}
                onclick={() => registerForEvent(btn.id)}
                class="w-full sm:w-auto !text-sm !py-2"
              >
                {#if isRegistered}
                  <Check size={14} class="mr-1" /> Inscrit
                {:else}
                  {btn.label}
                {/if}
                {#if btn.requiresPayment && !isRegistered}
                  <span class="ml-1 opacity-80"
                    >({formatCurrency(btn.amountCents, btn.currency)})</span
                  >
                {/if}
              </Button>
              {#if isFull && !isRegistered}
                <span class="text-xs text-red-err font-bold">Complet</span>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Attached forms -->
  {#if formInfos.length > 0}
    <div class="px-5 pb-4 border-t border-cn-border/40 pt-4 space-y-2">
      {#each formInfos as fi (fi.id)}
        <a
          href="/forms/{fi.id}?redirect=/posts"
          class="flex items-center justify-between p-3 rounded-xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow/50 transition-all group"
        >
          <div class="flex items-center gap-3">
            <div
              class="p-2 rounded-lg {fi.submitted
                ? 'bg-green-ok/10 text-green-ok'
                : 'bg-cn-yellow/15 text-cn-dark'}"
            >
              {#if fi.submitted}
                <Check size={18} />
              {:else}
                <ClipboardList size={18} />
              {/if}
            </div>
            <div>
              <h3 class="font-bold text-sm text-text-main">{fi.title}</h3>
              <p class="text-xs text-text-muted">
                {fi.submitted ? 'Réponse envoyée' : 'Remplir le formulaire'}
              </p>
            </div>
          </div>
          <ExternalLink
            size={14}
            class="text-text-muted group-hover:text-cn-dark transition-colors"
          />
        </a>
      {/each}
    </div>
  {/if}

  <!-- Comments section -->
  {#if comments.length > 0 || showComments}
    <div class="border-t border-cn-border/40 px-5 py-3">
      {#if topLevelComments.length > 2 && !showComments}
        <button
          type="button"
          onclick={() => (showComments = true)}
          class="text-xs text-text-muted hover:text-text-main mb-2 flex items-center gap-1"
        >
          <ChevronDown size={14} />
          Voir les {topLevelComments.length} commentaires
        </button>
      {/if}

      {#if showComments}
        <button
          type="button"
          onclick={() => (showComments = false)}
          class="text-xs text-text-muted hover:text-text-main mb-2 flex items-center gap-1"
        >
          <ChevronUp size={14} />
          Masquer les commentaires
        </button>
      {/if}

      <div class="space-y-2">
        {#each showComments ? topLevelComments : topLevelComments.slice(-2) as comment (comment.id)}
          <div class="flex items-start gap-2">
            <div class="flex-1 min-w-0">
              <p class="text-sm">
                <span class="font-bold text-text-main mr-1"
                  >{comment.displayName || comment.userId}</span
                >
                <span class="text-text-main">{comment.text}</span>
              </p>
              <div class="flex items-center gap-3 mt-0.5">
                <span class="text-[0.65rem] text-text-muted">{timeAgo(comment.createdAt)}</span>
                <button
                  type="button"
                  onclick={() => handleLikeComment(comment.id)}
                  class="text-[0.65rem] font-semibold {comment.likes?.includes(currentUserId)
                    ? 'text-red-500'
                    : 'text-text-muted hover:text-text-main'} transition-colors"
                >
                  {#if comment.likes?.length}
                    {comment.likes.length} J'aime
                  {:else}
                    J'aime
                  {/if}
                </button>
              </div>
            </div>
          </div>
        {/each}
      </div>

      <!-- Add comment input -->
      <div class="flex items-center gap-2 mt-3 pt-3 border-t border-cn-border/30">
        <input
          type="text"
          bind:value={commentText}
          placeholder="Ajouter un commentaire..."
          class="flex-1 bg-transparent text-sm text-text-main placeholder:text-text-muted outline-none"
          onkeydown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleAddComment();
            }
          }}
        />
        <button
          type="button"
          onclick={handleAddComment}
          disabled={!commentText.trim() || submittingComment}
          class="text-cn-yellow hover:text-cn-yellow-hover disabled:opacity-30 transition-colors"
          aria-label="Envoyer le commentaire"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  {:else}
    <!-- Collapsed comment input -->
    <div class="border-t border-cn-border/40 px-5 py-3">
      <div class="flex items-center gap-2">
        <input
          type="text"
          bind:value={commentText}
          placeholder="Ajouter un commentaire..."
          class="flex-1 bg-transparent text-sm text-text-main placeholder:text-text-muted outline-none"
          onkeydown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleAddComment();
            }
          }}
        />
        <button
          type="button"
          onclick={handleAddComment}
          disabled={!commentText.trim() || submittingComment}
          class="text-cn-yellow hover:text-cn-yellow-hover disabled:opacity-30 transition-colors"
          aria-label="Envoyer le commentaire"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  {/if}

  <!-- Error / Success messages -->
  {#if errorMessage}
    <div class="mx-5 mb-4 p-3 rounded-xl bg-red-err/10 text-red-err text-sm font-medium border border-red-err/20">
      {errorMessage}
    </div>
  {/if}
  {#if actionMessage}
    <div class="mx-5 mb-4 p-3 rounded-xl bg-green-ok/10 text-green-ok text-sm font-medium border border-green-ok/20">
      {actionMessage}
    </div>
  {/if}
</Card>
