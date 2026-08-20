<script lang="ts">
  import { onMount } from 'svelte';
  import { pullToRefresh } from '$lib/actions/pullToRefresh';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import {
    listPosts,
    searchPosts,
    getMyScheduledPosts,
    deletePost,
    type PostEntity,
    type PostFeed,
    type ScheduledPost,
  } from '$lib/posts/api';
  import CreatePostForm from '$lib/components/posts/CreatePostForm.svelte';
  import PostCard from '$lib/components/posts/PostCard.svelte';
  import ScheduledPostsPanel from '$lib/components/posts/ScheduledPostsPanel.svelte';
  import ConversationsMiniPanel from '$lib/components/posts/ConversationsMiniPanel.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import { getToken } from '$lib/stores/auth';
  import { currentUserId } from '$lib/stores/user';
  import { RefreshCw, PenSquare, Inbox, Search, X } from '@lucide/svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { m } from '$lib/paraglide/messages';

  const LAST_SEEN_KEY = 'posts_last_seen_ts';
  const PAGE_SIZE = 10;

  let {
    data,
  }: {
    data: {
      posts: Promise<PostEntity[]>;
      feedParams: { feed: PostFeed; promo?: number; formation?: string };
    };
  } = $props();

  const userId = $derived(currentUserId() ?? '');
  let authToken = $state('');

  let postsOverride = $state<PostEntity[] | null>(null);
  /** Resolved value of data.posts - used as fallback when postsOverride is still null. */
  let initialPostsResolved = $state<PostEntity[] | null>(null);
  let loading = $state(false);
  let loadingMore = $state(false);
  let hasMore = $state(true);
  let errorMessage = $state('');
  let lastSeenTs = $state(0);
  const elementPostTs = new SvelteMap<Element, number>();
  let seenObserver: IntersectionObserver | null = null;

  function getSeenObserver(): IntersectionObserver {
    if (!seenObserver) {
      seenObserver = new IntersectionObserver(
        (entries) => {
          let maxTs = lastSeenTs;
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const ts = elementPostTs.get(entry.target);
              if (ts !== undefined && ts > maxTs) maxTs = ts;
            }
          }
          if (maxTs > lastSeenTs) {
            lastSeenTs = maxTs;
            localStorage.setItem(LAST_SEEN_KEY, String(maxTs));
          }
        },
        { threshold: 0.3 }
      );
    }
    return seenObserver;
  }

  function markPostSeen(el: HTMLElement, post: PostEntity) {
    elementPostTs.set(el, postPublishedAt(post));
    getSeenObserver().observe(el);
    return {
      update(newPost: PostEntity) {
        elementPostTs.set(el, postPublishedAt(newPost));
      },
      destroy() {
        elementPostTs.delete(el);
        seenObserver?.unobserve(el);
      },
    };
  }

  let showCreateModal = $state(false);

  let searchQuery = $state('');
  let searchResults = $state<PostEntity[] | null>(null);
  let searching = $state(false);
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  let scheduledPosts = $state<ScheduledPost[]>([]);

  async function loadScheduled() {
    if (!currentUserId()) return;
    try {
      scheduledPosts = await getMyScheduledPosts();
    } catch {
      /* silent */
    }
  }

  async function deleteScheduled(id: string) {
    try {
      await deletePost(id);
      scheduledPosts = scheduledPosts.filter((p) => p.id !== id);
    } catch {
      /* silent */
    }
  }

  function onSearchInput(e: Event) {
    const q = (e.target as HTMLInputElement).value;
    searchQuery = q;
    if (searchDebounce) clearTimeout(searchDebounce);
    if (!q.trim()) {
      searchResults = null;
      return;
    }
    searchDebounce = setTimeout(async () => {
      searching = true;
      try {
        searchResults = await searchPosts(q.trim(), { limit: 20 });
      } finally {
        searching = false;
      }
    }, 400);
  }

  function clearSearch() {
    searchQuery = '';
    searchResults = null;
  }

  // Sentinel element for IntersectionObserver
  let sentinel = $state<HTMLElement | null>(null);

  const activeFeed = $derived((page.url.searchParams.get('feed') || 'associations') as PostFeed);

  $effect(() => {
    void page.url.search;
    postsOverride = null;
    initialPostsResolved = null;
    hasMore = true;
  });

  // Cache the resolved initial posts so the IntersectionObserver can use them
  // even before postsOverride is set (i.e., on first load).
  // Also initialise hasMore: the first batch uses limit=20, PAGE_SIZE=10.
  $effect(() => {
    initialPostsResolved = null;
    data.posts
      .then((posts) => {
        initialPostsResolved = posts;
        if (posts.length < 20) hasMore = false;
      })
      .catch(() => {});
  });

  function buildListOptions(offset = 0) {
    const u = page.url.searchParams;
    const feed = (u.get('feed') || 'associations') as PostFeed;
    const promoStr = u.get('promo');
    const promo = promoStr !== null && promoStr !== '' ? parseInt(promoStr, 10) : undefined;
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
    u.searchParams.delete('promo');
    u.searchParams.delete('formation');
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
      errorMessage = err instanceof Error ? err.message : m.posts_load_error_title();
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
      // Deduplicate in case new posts were inserted between page fetches.
      const existingIds = new Set(currentPosts.map((p) => p.id));
      const newPosts = more.filter((p) => !existingIds.has(p.id));
      postsOverride = [...currentPosts, ...newPosts];
    } catch {
      // silent - user can scroll back up and retry
    } finally {
      loadingMore = false;
    }
  }

  function onPostCreated() {
    showCreateModal = false;
    void refreshPosts();
    void loadScheduled();
  }

  function postPublishedAt(post: PostEntity): number {
    return new Date(post.scheduledAt ?? post.createdAt).getTime();
  }

  function isNew(post: PostEntity): boolean {
    if (!lastSeenTs) return false;
    return postPublishedAt(post) > lastSeenTs;
  }

  // Set up IntersectionObserver on sentinel
  $effect(() => {
    if (!sentinel) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          // postsOverride is null on first load - fall back to the cached initial posts
          const current = postsOverride ?? initialPostsResolved;
          if (current) void loadMorePosts(current);
        }
      },
      { rootMargin: '200px' }
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  });

  onMount(() => {
    if (userId) {
      getToken()
        .then((t) => {
          authToken = t;
        })
        .catch((e) => console.error('[Posts] Failed to get token', e));
      void loadScheduled();
    }

    const stored = localStorage.getItem(LAST_SEEN_KEY);
    lastSeenTs = stored ? parseInt(stored, 10) : 0;

    // Attach pull-to-refresh to the root scroll container (page-scroll-wrap in +layout.svelte).
    const scrollContainer = document.querySelector<HTMLElement>('.page-scroll-wrap');
    if (scrollContainer) {
      const { destroy } = pullToRefresh(scrollContainer, { onRefresh: refreshPosts });
      return destroy;
    }
  });
</script>

<main class="flex gap-6 px-4 py-6 md:px-8 md:py-8">
  <div class="min-w-0 flex-1">
    <div class="animate-rise-in mx-auto max-w-xl">
      <header class="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 class="font-brand text-text-main text-2xl font-bold tracking-tight">
            {m.posts_page_title()}
          </h1>
          <p class="text-text-muted mt-0.5 text-sm">{m.posts_page_subtitle()}</p>
        </div>
        <div class="flex items-center gap-2">
          <Button onclick={() => (showCreateModal = true)} class="!rounded-xl !px-4 !py-2 !text-sm">
            <PenSquare size={16} class="mr-1" />
            {m.posts_publish_button()}
          </Button>
        </div>
      </header>

      <!-- Barre de recherche -->
      <div class="relative mb-5">
        <Search
          size={16}
          class="text-text-muted pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2"
        />
        <input
          type="search"
          value={searchQuery}
          oninput={onSearchInput}
          placeholder={m.posts_search_placeholder()}
          class="border-cn-border text-text-main placeholder:text-text-muted/70 w-full rounded-2xl border bg-(--cn-surface)/60 py-2.5 pr-10 pl-10 text-sm font-medium transition-all outline-none focus:border-amber-500/50 focus:ring-2 focus:ring-amber-500/20"
        />
        {#if searchQuery}
          <button
            type="button"
            onclick={clearSearch}
            class="text-text-muted hover:text-text-main absolute top-1/2 right-3 -translate-y-1/2 transition-colors"
            aria-label={m.common_clear_aria()}
          >
            <X size={16} />
          </button>
        {/if}
      </div>

      <!-- Feed mode -->
      <div class="mb-5 flex flex-wrap gap-2" class:hidden={!!searchQuery}>
        <button
          type="button"
          onclick={() => navigateFeed('associations')}
          class="rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors {activeFeed ===
          'associations'
            ? 'text-text-main border-amber-500/40 bg-amber-500/15'
            : 'border-cn-border text-text-muted hover:text-text-main'}"
        >
          {m.posts_tab_associations()}
        </button>
        <button
          type="button"
          onclick={() => navigateFeed('followed')}
          class="rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors {activeFeed ===
          'followed'
            ? 'text-text-main border-amber-500/40 bg-amber-500/15'
            : 'border-cn-border text-text-muted hover:text-text-main'}"
        >
          {m.posts_tab_followed()}
        </button>
        <button
          type="button"
          onclick={() => navigateFeed('all')}
          class="rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors {activeFeed ===
          'all'
            ? 'text-text-main border-amber-500/40 bg-amber-500/15'
            : 'border-cn-border text-text-muted hover:text-text-main'}"
        >
          {m.posts_tab_all()}
        </button>
      </div>

      {#if scheduledPosts.length > 0}
        <ScheduledPostsPanel posts={scheduledPosts} onDelete={deleteScheduled} />
      {/if}

      <Modal
        open={showCreateModal}
        title={m.posts_new_post_title()}
        maxWidth="max-w-xl"
        onClose={() => (showCreateModal = false)}
      >
        <div class="p-1">
          <CreatePostForm {onPostCreated} />
        </div>
      </Modal>

      {#snippet skeletonCards()}
        {#each { length: 4 } as _, i (i)}
          <div
            class="border-cn-border animate-pulse space-y-3 rounded-3xl border bg-(--cn-surface)/60 p-5"
          >
            <div class="flex items-center gap-3">
              <div class="bg-cn-border/60 h-9 w-9 shrink-0 rounded-full"></div>
              <div class="flex-1 space-y-1.5">
                <div class="bg-cn-border/60 h-3 w-28 rounded-full"></div>
                <div class="bg-cn-border/40 h-2.5 w-20 rounded-full"></div>
              </div>
            </div>
            <div class="space-y-2">
              <div class="bg-cn-border/60 h-3 rounded-full" style="width: {85 - i * 5}%"></div>
              <div class="bg-cn-border/50 h-3 rounded-full" style="width: {70 - i * 3}%"></div>
              <div class="bg-cn-border/40 h-3 w-1/2 rounded-full"></div>
            </div>
          </div>
        {/each}
      {/snippet}

      <section>
        {#if searchQuery}
          <!-- Search results -->
          {#if searching}
            {@render skeletonCards()}
          {:else if searchResults !== null}
            {#if searchResults.length === 0}
              <div class="text-text-muted py-12 text-center text-sm">
                {m.posts_no_results({ query: searchQuery })}
              </div>
            {:else}
              <div class="space-y-5">
                {#each searchResults as post (post.id)}
                  <PostCard
                    {post}
                    currentUserId={userId}
                    {authToken}
                    onRefresh={refreshPosts}
                    onDelete={() => {
                      searchResults = (searchResults ?? []).filter((p) => p.id !== post.id);
                    }}
                  />
                {/each}
              </div>
            {/if}
          {/if}
        {:else}
          {#if errorMessage}
            <div
              class="bg-red-err/10 text-red-err border-red-err/20 mb-6 flex items-center gap-3 rounded-2xl border p-4 text-sm"
            >
              <span>{errorMessage}</span>
              <button class="ml-auto text-xs font-bold underline" onclick={refreshPosts}
                >{m.common_retry_button()}</button
              >
            </div>
          {/if}

          <!-- `postsOverride` is checked BEFORE the await, not inside its `{:then}`.
               `data.posts` is a streamed promise from the load function, and an `{#await}` on a
               promise that has REJECTED stays in `{:catch}` for the life of the component - so
               reading the override only from `{:then}` made it unreachable exactly when it
               mattered. "Reessayer" fetched the posts (measured: 200 in 326 ms on device) and had
               nowhere to render them; only leaving the page and coming back, which builds a new
               promise, appeared to work. A successful refetch must be rendered whatever the
               initial promise did. -->
          <div class="space-y-5">
            {#if postsOverride}
              {@render feedList(postsOverride)}
            {:else}
              {#await data.posts}
                {@render skeletonCards()}
              {:then initialPosts}
                {@render feedList(initialPosts)}
              {:catch _err}
                {#if loading}
                  {@render skeletonCards()}
                {:else}
                  <div
                    class="border-cn-border rounded-3xl border border-dashed bg-(--cn-surface)/50 px-6 py-16 text-center backdrop-blur-xl"
                  >
                    <Inbox size={48} class="text-text-muted mx-auto mb-3 opacity-40" />
                    <h3 class="text-text-main mb-1 text-lg font-bold">
                      {m.posts_load_error_title()}
                    </h3>
                    <button class="text-text-muted mt-1 text-sm underline" onclick={refreshPosts}
                      >{m.common_retry_button()}</button
                    >
                  </div>
                {/if}
              {/await}
            {/if}
          </div>

          {#snippet feedList(resolvedPosts: PostEntity[])}
            {#if loading}
              {@render skeletonCards()}
            {:else if resolvedPosts.length === 0}
              <div
                class="border-cn-border rounded-3xl border border-dashed bg-(--cn-surface)/50 px-6 py-16 text-center backdrop-blur-xl"
              >
                <Inbox size={48} class="text-text-muted mx-auto mb-3 opacity-40" />
                <h3 class="text-text-main mb-1 text-lg font-bold">{m.posts_empty_title()}</h3>
                {#if activeFeed === 'associations'}
                  <p class="text-text-muted text-sm">
                    {m.posts_no_results_asso()}
                  </p>
                {:else if activeFeed === 'followed'}
                  <p class="text-text-muted text-sm">
                    {m.posts_empty_followed()}
                    <button
                      type="button"
                      class="font-medium underline"
                      onclick={() => navigateFeed('all')}>{m.posts_tab_all()}</button
                    >.
                  </p>
                {:else}
                  <p class="text-text-muted text-sm">
                    {m.posts_empty_cta()}
                  </p>
                {/if}
              </div>
            {:else}
              {#each resolvedPosts as post (post.id)}
                <div class="relative" use:markPostSeen={post}>
                  {#if isNew(post)}
                    <span
                      class="text-cn-ink absolute -top-2 left-4 z-10 rounded-full bg-amber-500 px-2 py-0.5 text-[0.6rem] font-extrabold tracking-widest uppercase shadow-md shadow-amber-500/30"
                    >
                      {m.posts_badge_new()}
                    </span>
                  {/if}
                  <PostCard
                    {post}
                    currentUserId={userId}
                    {authToken}
                    onRefresh={refreshPosts}
                    onDelete={() => {
                      postsOverride = resolvedPosts.filter((p) => p.id !== post.id);
                    }}
                  />
                </div>
              {/each}

              <!-- Infinite-scroll sentinel -->
              <div bind:this={sentinel} class="h-4"></div>

              {#if loadingMore}
                <div class="flex justify-center py-4">
                  <RefreshCw size={20} class="text-text-muted animate-spin opacity-50" />
                </div>
              {:else if !hasMore && resolvedPosts.length >= PAGE_SIZE}
                <p class="text-text-muted py-4 text-center text-[0.75rem] opacity-50">
                  {m.posts_all_loaded()}
                </p>
              {/if}
            {/if}
          {/snippet}
        {/if}
      </section>
    </div>
  </div>

  <ConversationsMiniPanel />
</main>
