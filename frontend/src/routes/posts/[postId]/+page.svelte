<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import type { PostEntity } from '$lib/posts/api';
  import PostCard from '$lib/components/posts/PostCard.svelte';
  import { getToken } from '$lib/stores/auth';
  import { currentUserId } from '$lib/stores/user';
  import { ArrowLeft, FileX } from 'lucide-svelte';

  let { data }: { data: { post: PostEntity | null } } = $props();

  const userId = $derived(currentUserId() ?? '');
  let authToken = $state('');

  onMount(() => {
    getToken()
      .then((t) => {
        authToken = t;
      })
      .catch(() => {});
  });
</script>

<main class="px-4 py-6 md:px-8 md:py-8">
  <div class="mx-auto max-w-xl animate-rise-in">
    <button
      type="button"
      onclick={() => goto('/posts')}
      class="mb-6 flex items-center gap-2 text-sm font-medium text-text-muted transition-colors hover:text-text-main"
    >
      <ArrowLeft size={18} />
      Retour aux publications
    </button>

    {#if data.post}
      <PostCard
        post={data.post}
        currentUserId={userId}
        {authToken}
        onDelete={() => goto('/posts')}
      />
    {:else}
      <div class="text-center py-16 px-6 bg-[var(--cn-surface)]/50 backdrop-blur-xl rounded-3xl border border-dashed border-cn-border">
        <FileX size={48} class="mx-auto mb-3 text-text-muted opacity-40" />
        <h3 class="text-lg font-bold text-text-main mb-1">Publication introuvable</h3>
        <p class="text-text-muted text-sm">
          Cette publication n'existe plus ou a été supprimée.
        </p>
      </div>
    {/if}
  </div>
</main>
