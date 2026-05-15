<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import type { PostEntity } from '$lib/posts/api';
  import PostCard from '$lib/components/posts/PostCard.svelte';
  import { getToken } from '$lib/stores/auth';
  import { currentUserId } from '$lib/stores/user';
  import { ArrowLeft } from 'lucide-svelte';

  let { data }: { data: { post: PostEntity } } = $props();

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

    <PostCard
      post={data.post}
      currentUserId={userId}
      {authToken}
      onDelete={() => goto('/posts')}
    />
  </div>
</main>
