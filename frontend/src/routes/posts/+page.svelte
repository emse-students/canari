<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { listPosts, type PostEntity } from '$lib/posts/api';
  import CreatePostForm from '$lib/components/posts/CreatePostForm.svelte';
  import PostCard from '$lib/components/posts/PostCard.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import { getToken } from '$lib/stores/auth';

  // Global user state (could be moved to a store/context later)
  let userId = $state('');
  let email = $state('');
  let authToken = $state('');

  let posts = $state<PostEntity[]>([]);
  let loading = $state(false);
  let errorMessage = $state('');

  let showCreateModal = $state(false);
  let ws: WebSocket | null = null;

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
    showCreateModal = false;
    // No need to refresh manually if WS is working, but harmless to leave it
    // or we can remove it if we trust WS.
    // Let's keep it for safety in case WS fails.
    void refreshPosts();
  }

  function setupWebSocket(uid: string, token: string, devId: string) {
    if (ws) return;

    // Determine WS URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = import.meta.env.VITE_GATEWAY_URL
      ? new URL(import.meta.env.VITE_GATEWAY_URL).host
      : window.location.host;
    // Use /api/ws/ proxy from Vite or Nginx
    const wsUrl = `${protocol}//${host}/api/ws?token=${token}&device_id=${devId}`;

    console.log('[Posts] Connecting to WS:', wsUrl);
    ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'post_created' && msg.data) {
          console.log('[Posts] Received new post via WS', msg.data);
          // Add new post to top of list if not already there
          const newPost = msg.data as PostEntity;
          if (!posts.find((p) => p._id === newPost._id)) {
            posts = [newPost, ...posts];
          }
        }
      } catch (e) {
        console.error('[Posts] WS message error', e);
      }
    };

    ws.onclose = () => {
      console.log('[Posts] WS disconnected');
      ws = null;
    };

    ws.onerror = (e) => console.error('[Posts] WS error', e);
  }

  onMount(async () => {
    void refreshPosts();

    // Auth & Real-time setup
    const savedUser = localStorage.getItem('canari_saved_user');
    if (savedUser) {
      userId = savedUser;
      const deviceKey = `mls_device_id_${savedUser}`;
      let deviceId = localStorage.getItem(deviceKey);
      if (!deviceId) {
        deviceId = crypto.randomUUID();
        localStorage.setItem(deviceKey, deviceId);
      }

      try {
        const token = await getToken();
        authToken = token;
        setupWebSocket(savedUser, token, deviceId);
      } catch (e) {
        console.error('[Posts] Failed to get token', e);
      }
    }
  });

  onDestroy(() => {
    if (ws) {
      ws.close();
    }
  });
</script>

<main class="min-h-dvh bg-[var(--cn-bg)]/20 px-4 py-6 md:px-8 md:py-8">
  <div class="mx-auto max-w-4xl animate-rise-in">
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
      <div class="flex items-center gap-3">
        <Button variant="secondary" onclick={refreshPosts} {loading}>Refresh Feed</Button>
        <Button onclick={() => (showCreateModal = true)}>Create Post</Button>
      </div>
    </header>

    <!-- Create Post Modal -->
    <Modal
      open={showCreateModal}
      title="Create New Post"
      maxWidth="max-w-2xl"
      onClose={() => (showCreateModal = false)}
    >
      <div class="p-1">
        <CreatePostForm bind:email bind:authToken {onPostCreated} />
      </div>
    </Modal>

    <!-- Feed -->
    <section>
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
</main>
