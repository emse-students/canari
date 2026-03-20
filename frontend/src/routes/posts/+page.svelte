<script lang="ts">
  import { onMount } from 'svelte';
  import { listPosts, type PostEntity } from '$lib/posts/api';
  import CreatePostForm from '$lib/components/posts/CreatePostForm.svelte';
  import PostCard from '$lib/components/posts/PostCard.svelte';
  import Button from '$lib/components/ui/Button.svelte';

  // Global user state (could be moved to a store/context later)
  let userId = $state('');
  let email = $state('');
  let authToken = $state('');

  let posts = $state<PostEntity[]>([]);
  let loading = $state(false);
  let errorMessage = $state('');

  async function refreshPosts() {
    loading = true;
    errorMessage = '';
    try {
      posts = await listPosts(50);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Unable to load posts';
    } finally {
      loading = false;
    }
  }

  function onPostCreated() {
    void refreshPosts();
  }

  onMount(() => {
    void refreshPosts();
  });
</script>

<main class="h-full overflow-y-auto bg-[var(--cn-bg)]/20 px-4 py-6 md:px-8 md:py-8">
  <div class="mx-auto max-w-6xl animate-rise-in">
    <!-- Header -->
    <header class="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
      <div>
        <h1 class="text-3xl md:text-4xl font-extrabold text-text-main tracking-tight">
          Canari Posts
        </h1>
        <p class="text-text-muted mt-2 text-lg">
          Share updates, polls, and events with the community.
        </p>
      </div>
      <Button variant="secondary" onclick={refreshPosts} {loading}>Refresh Feed</Button>
    </header>

    <div class="grid grid-cols-1 lg:grid-cols-12 gap-8">
      <!-- Left Column: Create Post -->
      <section class="lg:col-span-5 xl:col-span-4 h-fit sticky top-24">
        <CreatePostForm bind:userId bind:email bind:authToken {onPostCreated} />

        <div
          class="mt-6 p-4 rounded-3xl bg-cn-surface/30 border border-cn-border/50 text-sm text-text-muted"
        >
          <h4 class="font-bold text-text-main mb-2">Tips</h4>
          <ul class="list-disc pl-4 space-y-1">
            <li>Use <code class="bg-cn-surface px-1 rounded">**bold**</code> for emphasis</li>
            <li>
              Mentions like <code class="bg-cn-surface px-1 rounded">@alice</code> will notify users
            </li>
            <li>Link directly to payment for events</li>
          </ul>
        </div>
      </section>

      <!-- Right Column: Feed -->
      <section class="lg:col-span-7 xl:col-span-8">
        {#if errorMessage}
          <div
            class="p-6 mb-8 rounded-3xl bg-red-50 text-red-600 border border-red-100 flex items-center gap-3"
          >
            <span class="text-2xl">⚠️</span>
            <span>{errorMessage}</span>
            <button class="ml-auto font-bold underline" onclick={refreshPosts}>Retry</button>
          </div>
        {/if}

        <div class="space-y-8">
          {#if loading && posts.length === 0}
            <div class="flex justify-center py-20">
              <div
                class="w-12 h-12 border-4 border-cn-yellow border-t-transparent rounded-full animate-spin"
              ></div>
            </div>
          {:else if posts.length === 0}
            <div
              class="text-center py-20 px-8 bg-white/50 backdrop-blur-xl rounded-[2.5rem] border-2 border-dashed border-cn-border"
            >
              <div class="text-6xl mb-4">📭</div>
              <h3 class="text-2xl font-bold text-text-main mb-2">No posts yet</h3>
              <p class="text-text-muted">Be the first to share something amazing!</p>
            </div>
          {:else}
            {#each posts as post (post._id)}
              <PostCard
                {post}
                currentUserId={userId}
                currentUserEmail={email}
                {authToken}
                onRefresh={refreshPosts}
              />
            {/each}
          {/if}
        </div>
      </section>
    </div>
  </div>
</main>
