<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import type { PostEntity } from '$lib/posts/api';
  import PostCard from '$lib/components/posts/PostCard.svelte';
  import { getToken } from '$lib/stores/auth';
  import { currentUserId } from '$lib/stores/user';
  import { ArrowLeft, FileX, Link, Check } from '@lucide/svelte';
  import { copyPublicShareLink } from '$lib/utils/copyShareLink';
  import { m } from '$lib/paraglide/messages';

  let { data }: { data: { post: PostEntity | null } } = $props();

  const userId = $derived(currentUserId() ?? '');
  let authToken = $state('');
  let copiedLink = $state(false);

  function copyPostLink() {
    const id = data.post?.id;
    if (!id) return;
    void copyPublicShareLink(`/posts/${id}`);
    copiedLink = true;
    setTimeout(() => (copiedLink = false), 2000);
  }

  onMount(() => {
    getToken()
      .then((t) => {
        authToken = t;
      })
      .catch(() => {});
  });
</script>

<main class="px-4 py-6 md:px-8 md:py-8">
  <div class="animate-rise-in mx-auto max-w-xl">
    <div class="mb-6 flex items-center justify-between gap-3">
      <button
        type="button"
        onclick={() => goto('/posts')}
        class="text-text-muted hover:text-text-main flex items-center gap-2 text-sm font-medium transition-colors"
      >
        <ArrowLeft size={18} />
        Retour aux publications
      </button>
      {#if data.post}
        <button
          type="button"
          onclick={copyPostLink}
          class="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors {copiedLink
            ? 'text-green-ok bg-green-50 dark:bg-green-950/20'
            : 'text-text-muted hover:text-text-main hover:bg-cn-border/30'}"
        >
          {#if copiedLink}
            <Check size={13} />{m.post_link_copied()}
          {:else}
            <Link size={13} />Partager
          {/if}
        </button>
      {/if}
    </div>

    {#if data.post}
      <PostCard
        post={data.post}
        currentUserId={userId}
        {authToken}
        onDelete={() => goto('/posts')}
      />
    {:else}
      <div
        class="border-cn-border rounded-3xl border border-dashed bg-(--cn-surface)/50 px-6 py-16 text-center backdrop-blur-xl"
      >
        <FileX size={48} class="text-text-muted mx-auto mb-3 opacity-40" />
        <h3 class="text-text-main mb-1 text-lg font-bold">Publication introuvable</h3>
        <p class="text-text-muted text-sm">{m.post_not_found_desc()}</p>
      </div>
    {/if}
  </div>
</main>
