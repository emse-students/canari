<script lang="ts">
  import { Log } from '$lib/utils/Log';
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
  import PostCornerBadge from '$lib/components/posts/PostCornerBadge.svelte';
  import ScheduledPostsPanel from '$lib/components/posts/ScheduledPostsPanel.svelte';
  import ConversationsMiniPanel from '$lib/components/posts/ConversationsMiniPanel.svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import { getToken } from '$lib/stores/auth';
  import { settings } from '$lib/stores/settingsStore.svelte';
  import { currentUserId } from '$lib/stores/user';
  import { RefreshCw, SquarePen, Inbox, Search, X } from '@lucide/svelte';
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

  /** The feed's three modes, in the order they are drawn. The pill itself is written once. */
  const FEED_TABS: { feed: PostFeed; label: () => string }[] = [
    { feed: 'associations', label: m.posts_tab_associations },
    { feed: 'followed', label: m.posts_tab_followed },
    { feed: 'all', label: m.posts_tab_all },
  ];

  let showCreateModal = $state(false);

  /**
   * `?compose=1` AND `?search=1` ARE COMMANDS, NOT STATE MIRRORS.
   *
   * The phone's app header publishes and searches from every page, and it does both with a LINK -
   * there is no store to write into from outside this route. So each parameter performs its action
   * and is stripped in the same tick, with `replaceState` so no history entry carries it: a reload,
   * a share or a back gesture then lands on the feed rather than on a modal or a search box the
   * reader did not ask for twice.
   */
  $effect(() => {
    const params = page.url.searchParams;
    const compose = params.get('compose') === '1';
    const search = params.get('search') === '1';
    if (!compose && !search) return;

    if (compose) showCreateModal = true;
    if (search) {
      searchOpen = true;
      // The glyph's whole purpose is to reach the field, so arriving there is part of the gesture.
      queueMicrotask(() => searchInput?.focus());
    }

    const u = new URL(page.url);
    u.searchParams.delete('compose');
    u.searchParams.delete('search');
    void goto(u, { replaceState: true, noScroll: true, keepFocus: true });
  });

  /**
   * Whether the phone shows the search field. It is ALWAYS shown from `md` up.
   *
   * The field was a permanent 66 px row on a 945 px screen, for a control most visits never use -
   * measured against the feed's own chrome on A1, which spent more height on heading, publish button
   * and search than on the first post. It is now behind the app header's magnifier, which is where
   * Facebook keeps its own, read on this phone the same day. Nothing moved further away: it was one
   * tap from the top of this page and it is one tap from the top of every page.
   */
  let searchOpen = $state(false);
  let searchInput = $state<HTMLInputElement | null>(null);

  /** Closes the field and drops whatever it was filtering by, which are one gesture. */
  function closeSearch() {
    searchOpen = false;
    clearSearch();
  }

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

  /**
   * WHICH TAB IS CURRENT, AND IT COMES FROM `load` RATHER THAN FROM THE URL.
   *
   * This read `page.url.searchParams.get('feed') || 'associations'`, which is the SAME decision
   * `load` makes and a DIFFERENT implementation of it - and the two disagreed the moment the
   * remembered tab was added, because a bare `/posts` has no `feed` parameter at all. Measured
   * 2026-09-10: with `canari_preferred_post_feed = followed` stored, a reload fetched the
   * followed feed and drew "Associations" as the selected tab. The posts were right and the
   * highlight was wrong, which is the worst of the three possible outcomes.
   *
   * `load` resolves url -> preference -> default once and publishes the answer; nothing else
   * re-derives it.
   */
  const activeFeed = $derived(data.feedParams.feed);

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

  /**
   * The next page's query, and it asks for exactly what the first page asked for.
   *
   * This used to re-parse `feed`, `promo` and `formation` off the URL - a third copy of `load`'s
   * parsing, complete with its own `parseInt` and its own default - so page 2 could be fetched
   * from a different feed than page 1 whenever the two disagreed. `load` publishes what it
   * resolved; the only thing that changes between pages is the offset.
   */
  function buildListOptions(offset = 0) {
    return { limit: PAGE_SIZE, offset, ...data.feedParams };
  }

  /**
   * Switches feed, and REMEMBERS IT - the tab is a preference, not a navigation.
   *
   * Written here and not in `load`, which is the distinction that makes the feature work: `load`
   * also runs for a link someone was sent, and recording the feed there would let a shared
   * `?feed=all` quietly rewrite the reader's own choice. Only a click on a tab is a choice.
   */
  function navigateFeed(feed: PostFeed) {
    settings.setPreferredPostFeed(feed);
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
      Log.d('refreshPosts failed', err);
      errorMessage = m.posts_load_error_title();
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

{#snippet skeletonCards()}
  {#each { length: 4 } as _, i (i)}
    <div class="border-cn-border bg-cn-surface animate-pulse space-y-3 rounded-3xl border p-5">
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

<PageContainer>
  {#snippet aside()}
    <ConversationsMiniPanel />
  {/snippet}

  <!--
    NO PAGE HEADING ON A PHONE (user, 2026-09-14: *"ce genre d'en-tete sert-il a quelque chose meme ?
    Pourquoi un titre et un sous titre ? C'est un reseau social, pas besoin de blablater autant"*).

    "Fil social / Partage, sondages et evenements" named a page the bottom bar already highlights and
    described content that says the same thing by existing, and the heading carried the publish
    button and the search field under it. Together they took roughly the top two thirds of a 945 px
    screen before the first post. The two controls moved into the app header, where they cost no page
    height and work from every route; what was left to hide is the prose.

    It stays from `md` up, unchanged. There the sidebar is the only thing naming the page, a 2xl title
    costs nothing in a 1280 px column, and `PageHeader` is the convention all 34 routes share - which
    is worth keeping wherever it is not actively in the way.
  -->
  <div class="hidden md:block">
    <PageHeader title={m.posts_page_title()}>
      {#snippet actions()}
        <Button onclick={() => (showCreateModal = true)} class="rounded-xl! px-4! py-2! text-sm!">
          <SquarePen size={16} class="mr-1" />
          {m.posts_publish_button()}
        </Button>
      {/snippet}
    </PageHeader>
  </div>

  <!-- Barre de recherche - masquee derriere la loupe sur telephone, toujours visible des `md`. -->
  <div id="posts-search" class="relative mb-5 {searchOpen ? '' : 'hidden md:block'}">
    <Search
      size={16}
      class="text-text-muted pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2"
    />
    <input
      bind:this={searchInput}
      type="search"
      value={searchQuery}
      oninput={onSearchInput}
      placeholder={m.posts_search_placeholder()}
      class="ui-search-own-clear border-cn-border text-text-main placeholder:text-text-muted/70 bg-cn-surface w-full rounded-2xl border py-2.5 pr-10 pl-10 text-sm font-medium transition-all outline-none focus:border-amber-500/50 focus:ring-2 focus:ring-amber-500/20"
    />
    <!--
      ONE BUTTON FOR TWO WIDTHS, because the two gestures are the same gesture. From `md` up the
      field is permanent, so this appears with a query and clears it. Below `md` the field only
      exists while it is open, so it is always there and closes it - and closing drops the query,
      since a hidden field still filtering the feed is a filter with no visible cause.
    -->
    {#if searchQuery || searchOpen}
      <button
        type="button"
        onclick={closeSearch}
        class="text-text-muted hover:text-text-main absolute top-1/2 right-3 -translate-y-1/2 transition-colors"
        aria-label={m.common_clear_aria()}
      >
        <X size={16} />
      </button>
    {/if}
  </div>

  <!--
    ONE BUTTON, THREE TIMES, IS ONE BUTTON. These were three copies of the same twelve lines
    differing only in feed key and label, so a change to the pill - the state colours, the padding,
    an aria attribute - had to be made three times or made wrong twice.
  -->
  <div class="mb-5 flex flex-wrap items-center gap-2">
    <div class="flex flex-wrap gap-2" class:hidden={!!searchQuery}>
      {#each FEED_TABS as tab (tab.feed)}
        <button
          type="button"
          onclick={() => navigateFeed(tab.feed)}
          aria-pressed={activeFeed === tab.feed}
          class="rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors {activeFeed ===
          tab.feed
            ? 'text-text-main border-amber-500/40 bg-amber-500/15'
            : 'border-cn-border text-text-muted hover:text-text-main'}"
        >
          {tab.label()}
        </button>
      {/each}
    </div>
  </div>

  {#if scheduledPosts.length > 0}
    <ScheduledPostsPanel posts={scheduledPosts} onDelete={deleteScheduled} />
  {/if}

  <Modal
    open={showCreateModal}
    title={m.posts_new_post_title()}
    maxWidth="max-w-[42.5rem]"
    onClose={() => (showCreateModal = false)}
  >
    <div class="p-1">
      <CreatePostForm {onPostCreated} />
    </div>
  </Modal>

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
                class="border-cn-border bg-cn-surface rounded-3xl border border-dashed px-6 py-16 text-center"
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
            class="border-cn-border bg-cn-surface rounded-3xl border border-dashed px-6 py-16 text-center"
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
                <PostCornerBadge label={m.posts_badge_new()} />
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
            <p class="text-text-muted text-2xs py-4 text-center opacity-50">
              {m.posts_all_loaded()}
            </p>
          {/if}
        {/if}
      {/snippet}
    {/if}
  </section>
</PageContainer>
