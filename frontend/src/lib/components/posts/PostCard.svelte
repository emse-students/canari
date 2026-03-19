<script lang="ts">
  import { registerEvent, votePoll, type PostEntity } from '$lib/posts/api';
  import SvelteMarkdown from 'svelte-markdown';
  import PostImage from '$lib/components/PostImage.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Card from '$lib/components/ui/Card.svelte';

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
  //   let pollSelections = $state<Record<string, string[]>>({});
  let selectedOptions = $state<string[]>([]);

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
      errorMessage = 'Set user id before voting.';
      return;
    }
    if (selectedOptions.length === 0) {
      errorMessage = 'Select at least one option to vote.';
      return;
    }

    try {
      await votePoll(post._id, pollId, {
        userId: currentUserId.trim(),
        optionIds: selectedOptions,
      });
      actionMessage = 'Vote submitted.';
      selectedOptions = []; // Reset local selection
      onRefresh();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Unable to submit vote';
    }
  }

  async function registerForEvent(buttonId: string) {
    if (!currentUserId.trim()) {
      errorMessage = 'Set user id before event registration.';
      return;
    }

    try {
      const response = await registerEvent(post._id, buttonId, {
        userId: currentUserId.trim(),
        email: currentUserEmail?.trim() || undefined,
      });

      if (response.checkoutUrl) {
        window.open(response.checkoutUrl, '_blank', 'noopener,noreferrer');
      }

      actionMessage =
        response.message ||
        (response.checkoutUrl ? 'Redirecting to Stripe checkout.' : 'Registration updated.');
      onRefresh();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Unable to register for event';
    }
  }

  function formatCurrency(amountCents: number | undefined, currency = 'eur') {
    if (!amountCents || amountCents <= 0) return '';
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amountCents / 100);
  }
</script>

<Card class="mb-6 relative overflow-hidden group hover:shadow-md transition-shadow">
  <div class="flex justify-between items-start mb-4">
    <div class="flex items-center gap-3">
      <div
        class="w-10 h-10 rounded-full bg-cn-yellow/20 flex items-center justify-center text-cn-dark font-bold"
      >
        {post.authorId.slice(0, 2).toUpperCase()}
      </div>
      <div>
        <div class="font-bold text-text-main">@{post.authorId}</div>
        <div class="text-xs text-text-muted">{new Date(post.createdAt).toLocaleDateString()}</div>
      </div>
    </div>
  </div>

  <div class="prose prose-sm max-w-none text-text-main mb-6">
    <SvelteMarkdown source={post.markdown} />
  </div>

  {#if post.images && post.images.length > 0 && authToken}
    <div class="grid grid-cols-2 gap-2 mb-6">
      {#each post.images as img (img.mediaId)}
        <div class="rounded-xl overflow-hidden border border-cn-border">
          <PostImage media={img} {authToken} />
        </div>
      {/each}
    </div>
  {/if}

  {#if post.polls && post.polls.length > 0}
    <div class="space-y-4 mb-6">
      {#each post.polls as poll (poll.id)}
        <div class="rounded-xl border border-cn-border bg-cn-surface/30 p-4">
          <h4 class="font-bold mb-3 text-lg">{poll.question}</h4>
          <div class="space-y-2">
            {#each poll.options as option (option.id)}
              {@const isSelected = selectedOptions.includes(option.id)}
              <button
                class="w-full text-left p-3 rounded-xl border-2 transition-all flex justify-between items-center group/opt
                {isSelected
                  ? 'border-cn-yellow bg-cn-yellow/5'
                  : 'border-cn-border hover:border-cn-yellow/50 bg-white'}"
                onclick={() => toggleOption(poll.id, option.id, poll.multipleChoice)}
              >
                <span class="font-medium">{option.label}</span>
                <span class="text-sm font-mono text-text-muted bg-cn-surface px-2 py-1 rounded-lg">
                  {option.votes} votes
                </span>
              </button>
            {/each}
          </div>
          <div class="mt-4 flex justify-end">
            <Button
              variant="primary"
              class="px-8"
              disabled={selectedOptions.length === 0}
              onclick={() => submitVote(poll.id)}
            >
              Vote
            </Button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if post.eventButtons && post.eventButtons.length > 0}
    <div class="flex flex-wrap gap-4 mt-6 pt-6 border-t border-cn-border">
      {#each post.eventButtons as btn (btn.id)}
        {@const isRegistered = btn.registrants.includes(currentUserId)}
        {@const isFull = Boolean(btn.capacity && btn.registrants.length >= btn.capacity)}

        <div class="flex flex-col items-start gap-2">
          <Button
            variant={isRegistered ? 'ghost' : 'primary'}
            disabled={isRegistered || (isFull && !isRegistered)}
            onclick={() => registerForEvent(btn.id)}
            class="w-full sm:w-auto"
          >
            {isRegistered ? 'Registered ✓' : btn.label}
            {#if btn.requiresPayment && !isRegistered}
              <span class="ml-1 opacity-80">({formatCurrency(btn.amountCents, btn.currency)})</span>
            {/if}
          </Button>
          {#if isFull && !isRegistered}
            <span class="text-xs text-red-500 font-bold">Event Full</span>
          {/if}
          {#if isRegistered}
            <span class="text-xs text-green-600 font-bold">You are going!</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if errorMessage}
    <div
      class="mt-4 p-3 rounded-xl bg-red-50 text-red-600 text-sm font-medium border border-red-100"
    >
      {errorMessage}
    </div>
  {/if}
  {#if actionMessage}
    <div
      class="mt-4 p-3 rounded-xl bg-green-50 text-green-600 text-sm font-medium border border-green-100"
    >
      {actionMessage}
    </div>
  {/if}
</Card>
