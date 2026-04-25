<script lang="ts">
  import { onMount } from 'svelte';
  import { listPosts, type PostEntity } from '$lib/posts/api';
  import CreatePostForm from '$lib/components/posts/CreatePostForm.svelte';
  import PostCard from '$lib/components/posts/PostCard.svelte';
  import ConversationsMiniPanel from '$lib/components/posts/ConversationsMiniPanel.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import { getToken } from '$lib/stores/auth';
  import { currentUserId } from '$lib/stores/user';
  import { RefreshCw, PenSquare, Inbox } from 'lucide-svelte';

  let userId = $state('');
  let email = $state('');
  let authToken = $state('');

  let posts = $state<PostEntity[]>([]);
  let loading = $state(false);
  let errorMessage = $state('');

  let showCreateModal = $state(false);

  async function refreshPosts() {
    loading = true;
    errorMessage = '';
    try {
      posts = await listPosts(50);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Impossible de charger les posts';
    } finally {
      loading = false;
    }
  }

  function onPostCreated() {
    showCreateModal = false;
    void refreshPosts();
  }

  onMount(async () => {
    void refreshPosts();

    const savedUser = currentUserId();
    if (savedUser) {
      userId = savedUser;
      try {
        authToken = await getToken();
      } catch (e) {
        console.error('[Posts] Failed to get token', e);
      }
    }
  });
</script>

<main class="flex gap-6 px-4 py-6 md:px-8 md:py-8">
  <!-- Posts feed -->
  <div class="flex-1 min-w-0">
    <div class="mx-auto max-w-xl animate-rise-in">
      <!-- Header -->
      <header class="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 class="text-2xl font-brand font-bold text-text-main tracking-tight">Fil social</h1>
          <p class="text-text-muted text-sm mt-0.5">Partage, sondages et évènements</p>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            onclick={refreshPosts}
            disabled={loading}
            class="p-2 rounded-xl border border-cn-border text-text-muted hover:text-text-main hover:bg-[var(--cn-surface)] transition-colors disabled:opacity-40"
            aria-label="Rafraîchir"
          >
            <RefreshCw size={18} class={loading ? 'animate-spin' : ''} />
          </button>
          <Button onclick={() => (showCreateModal = true)} class="!py-2 !px-4 !text-sm !rounded-xl">
            <PenSquare size={16} class="mr-1" />
            Publier
          </Button>
        </div>
      </header>

      <!-- Create Post Modal -->
      <Modal
        open={showCreateModal}
        title="Nouveau post"
        maxWidth="max-w-xl"
        onClose={() => (showCreateModal = false)}
      >
        <div class="p-1">
          <CreatePostForm {onPostCreated} />
        </div>
      </Modal>

      <!-- Feed -->
      <section>
        {#if errorMessage}
          <div
            class="p-4 mb-6 rounded-2xl bg-red-err/10 text-red-err border border-red-err/20 flex items-center gap-3 text-sm"
          >
            <span>{errorMessage}</span>
            <button class="ml-auto font-bold underline text-xs" onclick={refreshPosts}
              >Réessayer</button
            >
          </div>
        {/if}

        <div class="space-y-5">
          {#if loading && posts.length === 0}
            <div class="flex justify-center py-20">
              <div
                class="w-10 h-10 border-3 border-cn-yellow border-t-transparent rounded-full animate-spin"
              ></div>
            </div>
          {:else if posts.length === 0}
            <div
              class="text-center py-16 px-6 bg-[var(--cn-surface)]/50 backdrop-blur-xl rounded-3xl border border-dashed border-cn-border"
            >
              <Inbox size={48} class="mx-auto mb-3 text-text-muted opacity-40" />
              <h3 class="text-lg font-bold text-text-main mb-1">Aucun post</h3>
              <p class="text-text-muted text-sm">Soyez le premier à partager quelque chose !</p>
            </div>
          {:else}
            {#each posts as post (post.id)}
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

  <!-- Conversations sidebar (desktop only) -->
  <ConversationsMiniPanel />
</main>
