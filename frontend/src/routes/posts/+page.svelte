<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { listPosts, type PostEntity, type PostFeed } from '$lib/posts/api';
  import CreatePostForm from '$lib/components/posts/CreatePostForm.svelte';
  import PostCard from '$lib/components/posts/PostCard.svelte';
  import ConversationsMiniPanel from '$lib/components/posts/ConversationsMiniPanel.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { getToken } from '$lib/stores/auth';
  import { currentUserId } from '$lib/stores/user';
  import { RefreshCw, PenSquare, Inbox } from 'lucide-svelte';

  const LAST_VISIT_KEY = 'posts_last_visit';
  const PAGE_SIZE = 20;

  let {
    data,
  }: {
    data: {
      posts: Promise<PostEntity[]>;
      feedParams: { feed: PostFeed; promo?: number; formation?: string };
    };
  } = $props();

  let userId = $state('');
  let email = $state('');
  let authToken = $state('');

  let postsOverride = $state<PostEntity[] | null>(null);
  let loading = $state(false);
  let loadingMore = $state(false);
  let hasMore = $state(true);
  let errorMessage = $state('');
  let lastVisitTs = $state(0);

  let showCreateModal = $state(false);

  let customPromo = $state('');
  let customFormation = $state('');

  // Sentinel element for IntersectionObserver
  let sentinel = $state<HTMLElement | null>(null);

  const activeFeed = $derived((page.url.searchParams.get('feed') || 'all') as PostFeed);

  $effect(() => {
    void page.url.search;
    postsOverride = null;
    hasMore = true;
  });

  $effect(() => {
    const fp = data.feedParams;
    if (fp.promo !== undefined) customPromo = String(fp.promo);
    else customPromo = '';
    customFormation = fp.formation ?? '';
  });

  function buildListOptions(offset = 0) {
    const u = page.url.searchParams;
    const feed = (u.get('feed') || 'all') as PostFeed;
    const promoStr = u.get('promo');
    const promo =
      promoStr !== null && promoStr !== '' ? parseInt(promoStr, 10) : undefined;
    const formation = u.get('formation')?.trim() || undefined;
    return {
      limit: PAGE_SIZE,
      offset,
      feed,
      promo: promo !== undefined && Number.isFinite(promo) ? promo : undefined,
      formation,
    };
  }

  function navigateFeed(feed: PostFeed) {
    const u = new URL(page.url);
    u.searchParams.set('feed', feed);
    if (feed !== 'custom') {
      u.searchParams.delete('promo');
      u.searchParams.delete('formation');
    }
    void goto(u, { invalidateAll: true, noScroll: true });
  }

  function applyCustomFeed() {
    const u = new URL(page.url);
    u.searchParams.set('feed', 'custom');
    const p = customPromo.trim();
    if (p) u.searchParams.set('promo', p);
    else u.searchParams.delete('promo');
    if (customFormation.trim()) u.searchParams.set('formation', customFormation.trim());
    else u.searchParams.delete('formation');
    void goto(u, { invalidateAll: true, noScroll: true });
  }

  async function refreshPosts() {
    loading = true;
    errorMessage = '';
    hasMore = true;
    try {
      postsOverride = await listPosts(buildListOptions(0));
      hasMore = (postsOverride?.length ?? 0) >= PAGE_SIZE;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Impossible de charger les posts';
    } finally {
      loading = false;
    }
  }

  async function loadMorePosts(currentPosts: PostEntity[]) {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    try {
      const more = await listPosts(buildListOptions(currentPosts.length));
      if (more.length === 0 || more.length < PAGE_SIZE) hasMore = false;
      postsOverride = [...currentPosts, ...more];
    } catch {
      // silent — user can scroll back up and retry
    } finally {
      loadingMore = false;
    }
  }

  function onPostCreated() {
    showCreateModal = false;
    void refreshPosts();
  }

  function isNew(post: PostEntity): boolean {
    if (!lastVisitTs) return false;
    return new Date(post.createdAt).getTime() > lastVisitTs;
  }

  // Set up IntersectionObserver on sentinel
  $effect(() => {
    if (!sentinel) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          const current = postsOverride;
          if (current) void loadMorePosts(current);
        }
      },
      { rootMargin: '200px' }
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  });

  onMount(() => {
    const savedUser = currentUserId();
    if (savedUser) {
      userId = savedUser;
      getToken()
        .then((t) => { authToken = t; })
        .catch((e) => console.error('[Posts] Failed to get token', e));
    }

    // Record last visit timestamp for "Nouveau" badge
    const stored = localStorage.getItem(LAST_VISIT_KEY);
    lastVisitTs = stored ? parseInt(stored, 10) : 0;
    localStorage.setItem(LAST_VISIT_KEY, String(Date.now()));
  });
</script>

<main class="flex gap-6 px-4 py-6 md:px-8 md:py-8">
  <div class="flex-1 min-w-0">
    <div class="mx-auto max-w-xl animate-rise-in">
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

      <!-- Feed mode -->
      <div class="mb-5 flex flex-wrap gap-2">
        <button
          type="button"
          onclick={() => navigateFeed('all')}
          class="rounded-full px-3.5 py-1.5 text-sm font-medium border transition-colors {activeFeed === 'all'
            ? 'bg-amber-500/15 border-amber-500/40 text-text-main'
            : 'border-cn-border text-text-muted hover:text-text-main'}"
        >
          Tout
        </button>
        <button
          type="button"
          onclick={() => navigateFeed('followed')}
          class="rounded-full px-3.5 py-1.5 text-sm font-medium border transition-colors {activeFeed === 'followed'
            ? 'bg-amber-500/15 border-amber-500/40 text-text-main'
            : 'border-cn-border text-text-muted hover:text-text-main'}"
        >
          Suivis
        </button>
        <button
          type="button"
          onclick={() => navigateFeed('custom')}
          class="rounded-full px-3.5 py-1.5 text-sm font-medium border transition-colors {activeFeed === 'custom'
            ? 'bg-amber-500/15 border-amber-500/40 text-text-main'
            : 'border-cn-border text-text-muted hover:text-text-main'}"
        >
          Personnalisé
        </button>
      </div>

      {#if activeFeed === 'custom'}
        <div class="mb-5 rounded-2xl border border-cn-border bg-[var(--cn-surface)]/40 p-4 space-y-3">
          <p class="text-xs text-text-muted">
            Filtre les posts personnels par promotion ou formation (les posts des associations sont exclus).
          </p>
          <div class="flex flex-col sm:flex-row gap-3 sm:items-end">
            <Input label="Promotion (année)" type="number" placeholder="ex. 2026" class="flex-1" bind:value={customPromo} />
            <Input label="Formation" placeholder="ex. Ingénieur" class="flex-1" bind:value={customFormation} />
            <Button type="button" onclick={applyCustomFeed} class="!shrink-0">Appliquer</Button>
          </div>
        </div>
      {/if}

      <Modal open={showCreateModal} title="Nouveau post" maxWidth="max-w-xl" onClose={() => (showCreateModal = false)}>
        <div class="p-1">
          <CreatePostForm {onPostCreated} />
        </div>
      </Modal>

      <section>
        {#if errorMessage}
          <div class="p-4 mb-6 rounded-2xl bg-red-err/10 text-red-err border border-red-err/20 flex items-center gap-3 text-sm">
            <span>{errorMessage}</span>
            <button class="ml-auto font-bold underline text-xs" onclick={refreshPosts}>Réessayer</button>
          </div>
        {/if}

        <div class="space-y-5">
          {#snippet skeletonCards()}
            {#each { length: 4 } as _, i (i)}
              <div class="rounded-3xl border border-cn-border bg-[var(--cn-surface)]/60 p-5 space-y-3 animate-pulse">
                <div class="flex items-center gap-3">
                  <div class="w-9 h-9 rounded-full bg-cn-border/60 shrink-0"></div>
                  <div class="space-y-1.5 flex-1">
                    <div class="h-3 w-28 rounded-full bg-cn-border/60"></div>
                    <div class="h-2.5 w-20 rounded-full bg-cn-border/40"></div>
                  </div>
                </div>
                <div class="space-y-2">
                  <div class="h-3 rounded-full bg-cn-border/60" style="width: {85 - i * 5}%"></div>
                  <div class="h-3 rounded-full bg-cn-border/50" style="width: {70 - i * 3}%"></div>
                  <div class="h-3 w-1/2 rounded-full bg-cn-border/40"></div>
                </div>
              </div>
            {/each}
          {/snippet}

          {#await data.posts}
            {@render skeletonCards()}
          {:then initialPosts}
            {@const resolvedPosts = postsOverride ?? initialPosts}
            {#if loading}
              {@render skeletonCards()}
            {:else if resolvedPosts.length === 0}
              <div class="text-center py-16 px-6 bg-[var(--cn-surface)]/50 backdrop-blur-xl rounded-3xl border border-dashed border-cn-border">
                <Inbox size={48} class="mx-auto mb-3 text-text-muted opacity-40" />
                <h3 class="text-lg font-bold text-text-main mb-1">Aucun post</h3>
                {#if activeFeed === 'followed'}
                  <p class="text-text-muted text-sm">
                    Suivez des associations pour voir leurs publications ici, ou passez sur
                    <button type="button" class="underline font-medium" onclick={() => navigateFeed('all')}>Tout</button>.
                  </p>
                {:else if activeFeed === 'custom'}
                  <p class="text-text-muted text-sm">Aucun post personnel ne correspond à ces filtres.</p>
                {:else}
                  <p class="text-text-muted text-sm">Soyez le premier à partager quelque chose !</p>
                {/if}
              </div>
            {:else}
              {#each resolvedPosts as post (post.id)}
                <div class="relative">
                  {#if isNew(post)}
                    <span class="absolute -top-2 left-4 z-10 text-[0.6rem] font-extrabold uppercase tracking-widest bg-amber-500 text-[#151B2C] px-2 py-0.5 rounded-full shadow-md shadow-amber-500/30">
                      Nouveau
                    </span>
                  {/if}
                  <PostCard
                    {post}
                    currentUserId={userId}
                    currentUserEmail={email}
                    {authToken}
                    onRefresh={refreshPosts}
                    onDelete={() => {
                      postsOverride = resolvedPosts.filter((p) => p.id !== post.id);
                    }}
                  />
                </div>
              {/each}

              <!-- Sentinel pour l'infinite scroll -->
              <div bind:this={sentinel} class="h-4"></div>

              {#if loadingMore}
                <div class="flex justify-center py-4">
                  <RefreshCw size={20} class="animate-spin text-text-muted opacity-50" />
                </div>
              {:else if !hasMore && resolvedPosts.length >= PAGE_SIZE}
                <p class="text-center text-[0.75rem] text-text-muted opacity-50 py-4">
                  Vous avez tout vu !
                </p>
              {/if}
            {/if}
          {:catch _err}
            <div class="text-center py-16 px-6 bg-[var(--cn-surface)]/50 backdrop-blur-xl rounded-3xl border border-dashed border-cn-border">
              <Inbox size={48} class="mx-auto mb-3 text-text-muted opacity-40" />
              <h3 class="text-lg font-bold text-text-main mb-1">Impossible de charger les posts</h3>
              <button class="text-text-muted text-sm underline mt-1" onclick={refreshPosts}>Réessayer</button>
            </div>
          {/await}
        </div>
      </section>
    </div>
  </div>

  <ConversationsMiniPanel />
</main>
