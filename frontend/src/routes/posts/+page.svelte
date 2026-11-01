<script lang="ts">
  import { internalPath } from '$lib/utils/internalPath';
  import { resolve } from '$app/paths';
  import { Log } from '$lib/utils/Log';
  import { feedToShowAfterPublish } from '$lib/posts/landingFeed';
  import { onMount, untrack } from 'svelte';
  import { pullToRefresh } from '$lib/actions/pullToRefresh';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import {
    listPosts,
    searchPosts,
    getMyScheduledPosts,
    type PostEntity,
    type PostFeed,
    type ScheduledPost,
  } from '$lib/posts/api';
  import { FEED_FIRST_PAGE_SIZE, FEED_PAGE_SIZE, firstPageHasMore } from '$lib/posts/feedPageSize';
  import { msUntilNextDue, stillScheduled } from '$lib/posts/scheduledDue';
  import { deletePostAfterConfirm } from '$lib/posts/postDeletion';
  import { isFeedAudienceRefusal, isOutsideFeedAudience } from '$lib/posts/feedAudience';
  import {
    feedCacheKey,
    readFeedCache,
    writeFeedCache,
    type FeedCacheParams,
  } from '$lib/posts/feedCache';
  import {
    feedMayLoadMore,
    feedRefetchOnReconnect,
    refreshFirstPage,
    feedStoreAccess,
    firstPageFailure,
    listAfterFirstPage,
    loadStoredFeed,
    saveStoredFeed,
    storedCopyMayDraw,
    type FirstPageFailure,
    type FirstPageState,
  } from '$lib/posts/feedStore';
  import { globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { unlockUnattendedFor } from '$lib/stores/unlockPath.svelte';
  import { progressiveCount } from '$lib/utils/progressiveMount.svelte';
  import { feedHeldForLanding } from '$lib/posts/feedLandingHold';
  import { notifNav } from '$lib/stores/notifNav.svelte';
  import CreatePostForm from '$lib/components/posts/CreatePostForm.svelte';
  import PostCard from '$lib/components/posts/PostCard.svelte';
  import PostCornerBadge from '$lib/components/posts/PostCornerBadge.svelte';
  import ScheduledPostsPanel from '$lib/components/posts/ScheduledPostsPanel.svelte';
  import ConversationsMiniPanel from '$lib/components/posts/ConversationsMiniPanel.svelte';
  import { overlayLayout } from '$lib/stores/phoneViewport.svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import LiveOverlay from '$lib/components/live/LiveOverlay.svelte';
  import FeedTabRow from '$lib/components/posts/FeedTabRow.svelte';
  import { initialScrollDirection, nextScrollDirection } from '$lib/utils/scrollDirection';
  import LiveFeedCard from '$lib/components/live/LiveFeedCard.svelte';
  import LiveViewer from '$lib/components/live/LiveViewer.svelte';
  import { livesAvailable } from '$lib/utils/livesAvailability';
  import { serverLivesMode } from '$lib/stores/appVersionCheck.svelte';
  import type { LiveListItem } from '$lib/live/types';
  import { getToken } from '$lib/stores/auth';
  import { connectivity } from '$lib/stores/connectivity.svelte';
  import { isTransportFailure } from '$lib/utils/transportFailure';
  import { settings } from '$lib/stores/settingsStore.svelte';
  import { currentUserId } from '$lib/stores/user';
  import { RefreshCw, SquarePen, Inbox, Search, X } from '@lucide/svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { m } from '$lib/paraglide/messages';

  const LAST_SEEN_KEY = 'posts_last_seen_ts';

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

  /**
   * THE LIVE CARD ASKS FOR THE OPEN LIVES WHEN THE FEED ASKS FOR ITS FIRST PAGE (WP-L5): bumped by
   * the tab load and by `refreshPosts` (pull-to-refresh, retry, reconnect, a publish), so the card
   * has no timer of its own. `livesShown` keeps a production build, and an estate whose lives kill
   * switch is off, from asking at all.
   */
  let liveRefresh = $state(0);
  /**
   * The live card and the viewer are drawn: a `LIVE_ENABLED` build AND the server's lives kill
   * switch on (`livesAvailable`). Reactive on `/api/version`, so a switch closed by an admin takes
   * the card and an open viewer away at the next version refresh - the server already answers 404.
   */
  const livesShown = $derived(livesAvailable(serverLivesMode()));
  /** The live the viewer is open on, or null. */
  let openLive = $state<LiveListItem | null>(null);

  // A CLOSED SWITCH CLOSES THE VIEWER FOR GOOD. Hiding it alone kept `openLive` set, so when lives
  // reopened in the same session the viewer came back on a live nobody had asked to see again.
  $effect(() => {
    if (!livesShown && openLive) {
      Log.d('POSTS', `live ${openLive.id} viewer closed: lives are not available any more`);
      openLive = null;
    }
  });

  let postsOverride = $state<PostEntity[] | null>(null);
  /** Resolved value of data.posts - used as fallback when postsOverride is still null. */
  let initialPostsResolved = $state<PostEntity[] | null>(null);
  /**
   * THE LIST ON SCREEN, FROM ONE BLOCK. The `{#await}` used to draw the first answer in its `{:then}`
   * and the handler then moved it into `postsOverride`, drawn by ANOTHER block: every card mounted
   * twice, and the reel on screen opened its stream twice and logged its interrupted `play()` (Mi 9T,
   * v1.2.9-alpha.3). The handler fills one of these two in the same turn as the answer.
   */
  const shownPosts = $derived(postsOverride ?? initialPostsResolved);

  /**
   * THE LIST ON SCREEN WAS DRAWN FROM THE DEVICE'S STORED COPY (`$lib/posts/feedStore`) AND NO
   * SERVER ANSWER HAS REPLACED IT YET. While it holds, the feed says it is not confirmed, the
   * infinite scroll asks nothing, and every card is drawn without the reader's rights.
   */
  let fromStore = $state(false);
  /** The refresh of a stored copy failed without an answer: the copy stays, marked not refreshed. */
  let storedRefreshFailed = $state(false);
  /** A read of the stored copy is in flight: an error screen would flash before it draws. */
  let storedReadPending = $state(false);
  /**
   * Where the current tab's first request stands: `pending`, `answered` (a page came back),
   * `failed` (no answer - transport or 5xx), `refused` (401/403, an answer about this reader).
   */
  let firstPage = $state<FirstPageState>('pending');

  /**
   * The account and key the stored feed may be read and written with now, or `null` while an unlock
   * is pending - nothing stored is drawn on a locked device (`feedStoreAccess`).
   */
  const storeAccess = $derived(
    feedStoreAccess({
      currentUserId: currentUserId(),
      sessionUserId: globalSession.userId,
      deviceKeyB64: globalSession.deviceKeyB64,
      isLoggedIn: globalSession.isLoggedIn,
      unattendedFor: unlockUnattendedFor(),
    })
  );

  /** Keeps `posts` as the tab's stored first page, when the device may hold it now. */
  function storeFirstPage(params: FeedCacheParams, posts: PostEntity[]) {
    const access = storeAccess;
    if (!access) {
      Log.d('POSTS', 'first page not stored - the device key is not in hand for this account');
      return;
    }
    void saveStoredFeed(access, params, posts);
  }

  /**
   * Counts the tab loads of this page instance: a request remembers the count it was issued under,
   * and its answer is dropped when the reader has switched tab since (`refreshFirstPage`). Not
   * reactive: nothing is drawn from it.
   */
  let tabLoad = 0;

  /** Whether the tab row is drawn: false after a scroll down, true again on the first scroll up. */
  let tabsShown = $state(true);
  /**
   * Whether focus is inside the tab row. A row that hid under a focused tab would turn `inert` and
   * drop that focus to the body, so a keyboard user scrolling with a tab focused keeps the row.
   */
  let tabsFocused = $state(false);

  /**
   * Applies a failed feed read to the screen, as `firstPageFailure` classifies it: a 401/403 ends
   * every stored page and withdraws a copy on screen, so the refusal's own state is drawn; anything
   * else keeps the copy, unconfirmed and said once. Returns the classification.
   */
  function applyFirstPageFailure(err: unknown): FirstPageFailure {
    const failure = firstPageFailure(err, fromStore);
    if (failure.withdrawCopy) {
      postsOverride = null;
      fromStore = false;
      storedRefreshFailed = false;
    }
    if (failure.copyUnconfirmed) {
      storedRefreshFailed = true;
      console.warn(
        `[FEED-STORE] the feed could not be refreshed (${String(err)}) - the stored copy stays, unconfirmed`
      );
    }
    return failure;
  }

  /**
   * THE FIRST DRAW WAITS WHILE A NOTIFICATION LANDING IS UNDER WAY - this page is about to be left,
   * and drawing it cost the PIN path and the routing ~1-2 s of main thread on the Mi 9T. The rule and
   * its measurement are on {@link feedHeldForLanding}.
   */
  let feedDrawn = $state(false);
  const heldForLanding = $derived(
    feedHeldForLanding({ landingEnRoute: notifNav.enRoute, feedDrawn })
  );
  $effect(() => {
    if (heldForLanding) {
      Log.d('POSTS', 'first draw held - a deep-link landing is taking the reader elsewhere');
      return;
    }
    if ((postsOverride ?? initialPostsResolved) !== null) feedDrawn = true;
  });

  let loading = $state(false);
  let loadingMore = $state(false);
  let hasMore = $state(true);

  /**
   * THE FIRST SCREEN MOUNTS FIRST, THE REST A FRAME AT A TIME (`progressiveCount`). Mounting every
   * card at once was a 300-500 ms task inside the swipe's view-transition callback, which froze the
   * page the member had just released (Mi 9T, 2026-10-02).
   */
  const mounted = progressiveCount({
    // Nothing to mount while the first draw is held, or every card would land in one frame on release.
    total: () => (heldForLanding ? 0 : ((postsOverride ?? initialPostsResolved)?.length ?? 0)),
    resetKey: () => feedCacheKey(data.feedParams),
    initial: 3,
    batch: 2,
  });
  let errorMessage = $state('');
  /** The server said this reader has no space and no association: an empty state, not an error. */
  let noAudience = $state(false);
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
  /** The broadcaster's screen is open, with who it broadcasts as; it replaced the composer. */
  let liveTarget = $state<{ associationId: string | null; associationName: string | null } | null>(
    null
  );

  /** "En direct" from the composer: it closes (by state, no history change) and the live takes over. */
  function onGoLive(target: { associationId: string | null; associationName: string | null }) {
    Log.d('POSTS', 'going live from the composer: the composer closes, the live replaces it');
    showCreateModal = false;
    liveTarget = target;
  }

  /**
   * `?compose=1` AND `?search=1` ARE COMMANDS, NOT STATE MIRRORS.
   *
   * The phone's app header publishes and searches from every page, and it does both with a LINK -
   * there is no store to write into from outside this route. So each parameter performs its action
   * and is stripped in the same tick, with `replaceState` so no history entry carries it: a reload,
   * a share or a back gesture then lands on the feed rather than on a modal or a search box the
   * reader did not ask for twice.
   */
  /**
   * This route carrying `u`'s query and hash, for `resolve`. Built from the route rather than from
   * `u.pathname`, which already carries any base path and would then get it twice.
   */
  function feedPath(u: URL): string {
    const query = u.searchParams.toString();
    return `/posts${query ? `?${query}` : ''}${u.hash}`;
  }

  $effect(() => {
    const params = page.url.searchParams;
    const compose = params.get('compose') === '1';
    const search = params.get('search') === '1';
    if (!compose && !search) return;

    const u = new URL(page.url.href);
    u.searchParams.delete('compose');
    u.searchParams.delete('search');
    // THE STRIP FIRST, THE COMMAND ONCE IT HAS LANDED. The strip is a navigation, and the root
    // layout closes every open overlay before one (`drainHistoryOverlayStack`). SvelteKit 2 kept
    // the arriving navigation open through two ticks after its commit, and skipped every hook
    // while it was, so a strip fired by the arriving page ran no drain. SvelteKit 3 ends it as soon
    // as the page has settled, so the strip runs the hooks, and a modal opened in this same tick
    // was closed as it opened (Mi 9T, 2026-10-28). The command acts once the strip has landed.
    // That a replace would also overwrite an overlay's own history entry is the second reason.
    const perform = () => {
      if (compose) showCreateModal = true;
      if (search) {
        searchOpen = true;
        // The glyph's whole purpose is to reach the field, so arriving there is part of the gesture.
        queueMicrotask(() => searchInput?.focus());
      }
    };
    // Whether the strip landed is read off the page, never off the error: kit rejects an overtaken
    // navigation with an untyped `Error`, and the feed still on screen is the fact that decides.
    const landed = () => page.url.pathname === u.pathname;
    void goto(resolve(internalPath(feedPath(u))), { replace: true, reset: false }).then(
      () => {
        if (landed()) perform();
        else Log.i('POSTS', 'feed command dropped: the strip was overtaken by another navigation');
      },
      (e: unknown) => {
        if (!landed()) {
          Log.i('POSTS', `feed command dropped: the strip was overtaken (${String(e)})`);
          return;
        }
        console.error(`[POSTS] feed command not performed: its strip failed: ${String(e)}`);
      }
    );
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
  /**
   * The tab row is slid out only when the scroll says so, no search replaces the feed, and nothing
   * in it holds focus.
   */
  const tabsHidden = $derived(!tabsShown && !searchQuery && !tabsFocused);
  let searchResults = $state<PostEntity[] | null>(null);
  let searching = $state(false);
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  let scheduledPosts = $state<ScheduledPost[]>([]);
  /** Shown under the scheduled strip when a confirmed deletion failed; cleared by the next try. */
  let scheduledDeleteError = $state('');

  async function loadScheduled() {
    if (!currentUserId()) return;
    try {
      scheduledPosts = await getMyScheduledPosts();
    } catch (err) {
      // The strip stays as it was; the next load reads it again.
      Log.d('POSTS scheduled posts could not be loaded', err);
    }
  }

  /**
   * ONE timer, armed on the earliest scheduled time the strip holds - no polling clock. When it
   * fires the due posts leave the strip and the feed is re-read so they appear where the server
   * now publishes them; the effect then re-arms on the next one (it also re-runs whenever the list
   * changes, and a wait beyond the timer limit just wakes early and re-arms).
   */
  $effect(() => {
    const delay = msUntilNextDue(scheduledPosts, Date.now());
    if (delay === null) return;
    const timer = setTimeout(() => {
      const remaining = stillScheduled(scheduledPosts, Date.now());
      if (remaining.length === scheduledPosts.length) {
        // A capped wait, not a due post: re-arm without touching the feed.
        scheduledPosts = [...scheduledPosts];
        return;
      }
      Log.d('POSTS', `scheduled post(s) due: ${scheduledPosts.length - remaining.length}`);
      scheduledPosts = remaining;
      if (!searchResults) void refreshPosts();
    }, delay);
    return () => clearTimeout(timer);
  });

  /** Deletes a scheduled post once its author confirms, through the one deletion path. */
  async function deleteScheduled(id: string) {
    scheduledDeleteError = '';
    try {
      if ((await deletePostAfterConfirm(id)) === 'declined') return;
      scheduledPosts = scheduledPosts.filter((p) => p.id !== id);
    } catch (err) {
      // The post stays listed, which is the truth: it was not deleted - and the author who
      // confirmed is told so, rather than left reading a tap that did nothing.
      Log.d(`POSTS scheduled post ${id} could not be deleted`, err);
      scheduledDeleteError = m.post_unable_to_delete_post();
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

  /**
   * PAINT THE TAB FROM WHAT IT LAST HELD, THEN REPLACE IT WITH THE ANSWER.
   *
   * These were two effects and the first of them ran synchronously with the tap: it set
   * `postsOverride` and `initialPostsResolved` to `null`, so the feed the reader was looking at
   * became four skeletons before the new request had left the device. Switching tab and back cost
   * a full round trip each way for a list already in memory.
   *
   * The cached entry belongs to THIS tab and this reader ($lib/posts/feedCache), never to the tab
   * being left, so the highlighted pill and the posts under it cannot disagree. Everything the
   * reader has done since - a page appended by the infinite scroll, a post deleted - is kept: the
   * answer only replaces the paint it is replacing, which is what the identity check says.
   */
  $effect(() => {
    const params = data.feedParams;
    const key = feedCacheKey(params);
    const promise = data.posts;
    // A new tab load: a refresh or a next page still out for the previous one is now stale, and the
    // flags it set belong to nobody.
    tabLoad++;
    // Untracked: this effect must not depend on the counter it bumps.
    liveRefresh = untrack(() => liveRefresh) + 1;
    loading = false;
    loadingMore = false;

    const cached = readFeedCache(key);
    const stale = cached?.posts ?? null;
    postsOverride = stale;
    // WHAT IS ON SCREEN IS THE PROXY, NOT `stale`. A `$state` wraps the array it is given in a
    // proxy, so `postsOverride === stale` was false the moment anything was cached, and the
    // answer never replaced the paint: the feed was always one visit behind. A reel just
    // published never appeared on the feed it landed on (REEL-2 on the Mi 9T, 2026-10-02). The
    // proxy read back here keeps its identity until something else reassigns the list.
    const painted = untrack(() => postsOverride);
    initialPostsResolved = stale;
    hasMore = cached?.hasMore ?? true;
    fromStore = false;
    storedRefreshFailed = false;
    firstPage = 'pending';

    let cancelled = false;
    promise
      .then((posts) => {
        if (cancelled) return;
        firstPage = 'answered';
        // A first page shorter than it asked for is the end.
        const more = firstPageHasMore(posts.length);
        writeFeedCache(key, { posts, hasMore: more });
        initialPostsResolved = posts;
        storeFirstPage(params, posts);
        const next = listAfterFirstPage({
          answer: posts,
          onScreen: postsOverride,
          painted,
          fromStore,
        });
        if (next) {
          postsOverride = next;
          hasMore = more;
        }
        fromStore = false;
        storedRefreshFailed = false;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // With nothing on screen the `{#await}` shows its error state; with something cached the
        // reader keeps the feed they had rather than losing it to a timeout. A stored copy stays too,
        // and says it could not be refreshed - unless the failure is a refusal, which ends it.
        firstPage = applyFirstPageFailure(err).firstPage;
      });
    return () => {
      cancelled = true;
    };
  });

  /**
   * DRAW THE TAB'S STORED FIRST PAGE WHILE THE SERVER IS ASKED (local-first feed, 2026-10-15).
   *
   * Only when this page instance holds nothing for the tab (the in-memory cache of a tab switch is
   * younger), when no answer has come back yet - an answer that wins the race is drawn instead - and
   * when the device may read the account's store ({@link storeAccess}). A request that has already
   * FAILED does not stop it: offline, the failure usually lands before the store is read, and the
   * copy is exactly what offline needs; it is then drawn as not refreshed. A refusal does stop it.
   */
  $effect(() => {
    const access = storeAccess;
    const params = data.feedParams;
    if (!access) return;
    const mayDraw = untrack(() =>
      storedCopyMayDraw({ firstPage, onScreen: postsOverride ?? initialPostsResolved })
    );
    if (!mayDraw) return;

    let cancelled = false;
    const askedAt = performance.now();
    storedReadPending = true;
    void loadStoredFeed(access, params)
      .then((posts) => {
        if (cancelled) return;
        if (!posts) {
          Log.d('POSTS', 'no stored first page for this tab - the server draws it');
          return;
        }
        if (!storedCopyMayDraw({ firstPage, onScreen: postsOverride ?? initialPostsResolved })) {
          Log.d('POSTS', 'stored first page read after the server answered - not drawn');
          return;
        }
        postsOverride = posts;
        fromStore = true;
        hasMore = false;
        storedRefreshFailed = firstPage === 'failed';
        if (storedRefreshFailed) {
          console.warn(
            '[FEED-STORE] the feed request failed before the stored copy was read - drawn, unconfirmed'
          );
        }
        Log.d(
          'POSTS',
          `stored first page drawn: ${posts.length} posts read in ${Math.round(performance.now() - askedAt)} ms`
        );
      })
      .finally(() => {
        if (!cancelled) storedReadPending = false;
      });
    return () => {
      cancelled = true;
      storedReadPending = false;
    };
  });

  /**
   * The next page's query, and it asks for exactly what the first page asked for.
   *
   * This used to re-parse `feed`, `promo` and `formation` off the URL - a third copy of `load`'s
   * parsing, complete with its own `parseInt` and its own default - so page 2 could be fetched
   * from a different feed than page 1 whenever the two disagreed. `load` publishes what it
   * resolved; the only thing that changes between pages is the offset. The caller passes the tab's
   * params as it took them BEFORE its await, never `data.feedParams` read after it.
   */
  function buildListOptions(params: FeedCacheParams, offset: number) {
    return { limit: FEED_PAGE_SIZE, offset, ...params };
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
    showFeed(feed);
  }

  /** Opens a feed WITHOUT remembering it: the tab a reader chose is theirs, a publish is not a choice. */
  function showFeed(feed: PostFeed) {
    const u = new URL(page.url.href);
    u.searchParams.set('feed', feed);
    u.searchParams.delete('promo');
    u.searchParams.delete('formation');
    // An old `?kind=` (the 1.2.9 alphas' CanaReels filter) means nothing now: not carried along.
    u.searchParams.delete('kind');
    void goto(resolve(internalPath(feedPath(u))), { refreshAll: true, reset: false });
  }

  async function refreshPosts() {
    // The tab is taken NOW: an answer for a tab the reader has left is dropped (`refreshFirstPage`).
    const issuedFor = tabLoad;
    liveRefresh++;
    loading = true;
    errorMessage = '';
    hasMore = true;
    const outcome = await refreshFirstPage({
      params: data.feedParams,
      // The SAME first page the cold start asks and stores - never a scroll page (Mi 9T, alpha.3).
      read: (params) => listPosts({ limit: FEED_FIRST_PAGE_SIZE, offset: 0, ...params }),
      stillCurrent: () => issuedFor === tabLoad,
    });
    if (outcome.kind === 'stale') {
      // `loading` belongs to the tab on screen now, which reset it at the switch.
      Log.d('POSTS', 'a refresh answered for a tab the reader has left - dropped');
      return;
    }
    loading = false;
    if (outcome.kind === 'answered') {
      const { posts, params } = outcome;
      postsOverride = posts;
      hasMore = firstPageHasMore(posts.length);
      writeFeedCache(feedCacheKey(params), { posts, hasMore });
      // An answer: whatever the device drew is now the server's page, and the store follows it.
      firstPage = 'answered';
      fromStore = false;
      storedRefreshFailed = false;
      storeFirstPage(params, posts);
      return;
    }
    const err = outcome.error;
    Log.d('refreshPosts failed', err);
    const outside = isOutsideFeedAudience(err);
    // A copy that stays on screen says it could not be refreshed on its own line; the red banner
    // is for a feed that has nothing to show.
    const failure = applyFirstPageFailure(err);
    firstPage = failure.firstPage;
    if (outside) noAudience = true;
    else if (!failure.copyUnconfirmed) errorMessage = m.posts_load_error_title();
  }

  async function loadMorePosts(currentPosts: PostEntity[]) {
    // A stored copy is not paged (`feedMayLoadMore`).
    if (!feedMayLoadMore({ loadingMore, hasMore, fromStore })) return;
    // Same rule as `refreshPosts`: a page for a tab the reader has left is not appended to this one.
    const issuedFor = tabLoad;
    const params = data.feedParams;
    loadingMore = true;
    try {
      const more = await listPosts(buildListOptions(params, currentPosts.length));
      if (issuedFor !== tabLoad) {
        Log.d('POSTS', 'a next page answered for a tab the reader has left - dropped');
        return;
      }
      if (more.length === 0 || more.length < FEED_PAGE_SIZE) hasMore = false;
      // Deduplicate in case new posts were inserted between page fetches.
      const existingIds = new Set(currentPosts.map((p) => p.id));
      const newPosts = more.filter((p) => !existingIds.has(p.id));
      postsOverride = [...currentPosts, ...newPosts];
      writeFeedCache(feedCacheKey(params), { posts: postsOverride, hasMore });
    } catch {
      // silent - user can scroll back up and retry
    } finally {
      if (issuedFor === tabLoad) loadingMore = false;
    }
  }

  /**
   * A post must be visible where its author lands. `all` shows everything, so a reader on it stays;
   * anyone else is taken to the feed that holds the post - Associations for an association's,
   * All for a personal one - rather than back to a list that does not contain it.
   */
  function onPostCreated(landing: PostFeed | null) {
    showCreateModal = false;
    const target = feedToShowAfterPublish(activeFeed, landing);
    if (target) {
      Log.d('POSTS', `published post lands in "${target}", leaving "${activeFeed}"`);
      showFeed(target);
      void loadScheduled();
      return;
    }
    void refreshPosts();
    void loadScheduled();
  }

  function postPublishedAt(post: PostEntity): number {
    return new Date(post.publishedAt).getTime();
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

  /**
   * The token the cards draw their media with. Offline at launch there is none to have: that is the
   * transport, already reported by the session (`[A] refresh-transport`), so it is said once here for
   * what it costs this page - and the reconnect below asks again.
   */
  async function loadAuthToken() {
    try {
      authToken = await getToken();
    } catch (e) {
      if (isTransportFailure(e)) {
        console.log('[POSTS] no access token without the server - post media wait for the link');
        return;
      }
      console.error('[POSTS] the access token could not be read', e);
    }
  }

  /**
   * BACK ONLINE, THE FEED ASKS AGAIN BY ITSELF (Mi 9T reading of `v1.2.9-alpha.1`, 2026-10-15: after
   * an offline start the stored copy said "pas de reponse du serveur" 40 s after the server was
   * reachable, until "Reessayer"). It is the retry's own path, once per reconnect the server
   * confirmed, and only when the last request got no answer (`feedRefetchOnReconnect`).
   */
  function onReconnect() {
    if (userId && !authToken) void loadAuthToken();
    const decision = {
      firstPage,
      loading,
      serverReachable: connectivity.serverReachable,
    };
    if (!feedRefetchOnReconnect(decision)) return;
    Log.d('POSTS', 'server reachable again - the first page is asked again');
    void refreshPosts();
  }

  onMount(() => connectivity.onReconnect(onReconnect));

  onMount(() => {
    if (userId) {
      void loadAuthToken();
      void loadScheduled();
    }

    const stored = localStorage.getItem(LAST_SEEN_KEY);
    lastSeenTs = stored ? parseInt(stored, 10) : 0;

    // Attach pull-to-refresh to the root scroll container (page-scroll-wrap in +layout.svelte).
    const scrollContainer = document.querySelector<HTMLElement>('.page-scroll-wrap');
    if (scrollContainer) {
      const { destroy } = pullToRefresh(scrollContainer, { onRefresh: refreshPosts });
      // The tab row comes back on the first scroll UP (see `tabsShown`). No log per event.
      // Seeded at where the page already is (a restored scroll is not the top), so the first
      // event measures from there rather than reading the whole offset as one scroll down.
      let direction = initialScrollDirection(scrollContainer.scrollTop);
      const onScroll = () => {
        const max = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        // Clamped so a bounce at the bottom never reads as an upward scroll.
        direction = nextScrollDirection(direction, Math.min(scrollContainer.scrollTop, max));
        if (direction.shown !== tabsShown) tabsShown = direction.shown;
      };
      scrollContainer.addEventListener('scroll', onScroll, { passive: true });
      return () => {
        scrollContainer.removeEventListener('scroll', onScroll);
        destroy();
      };
    }
  });
</script>

<!--
  ONE CARD THAT THROWS FAILS ITSELF, NOT THE FEED. A duplicate key inside one post's attached forms
  put the whole of `/posts?feed=followed` behind the layout's error boundary (production, 1.2.9,
  2026-10-18), and the reader lost every other post with it. The defect is fixed where it was
  (`attachedFormsLoader`); this keeps the next one to its own card and NAMES the post in the log,
  which the layout's line could not - a production Svelte error carries only its code.
-->
{#snippet guardedCard(post: PostEntity, onDelete: () => void)}
  <svelte:boundary
    onerror={(e) =>
      console.error(`[POSTS] card ${post.id} failed to draw - the feed keeps the others:`, e)}
  >
    <PostCard {post} currentUserId={userId} {authToken} onRefresh={refreshPosts} {onDelete} />
    {#snippet failed(_error, reset)}
      <div
        class="border-cn-border bg-cn-surface text-text-muted flex items-center gap-3 rounded-3xl border border-dashed p-5 text-sm"
        role="alert"
      >
        <span>{m.posts_card_render_failed()}</span>
        <button type="button" class="tap-target ml-auto font-bold underline" onclick={reset}
          >{m.common_retry_button()}</button
        >
      </div>
    {/snippet}
  </svelte:boundary>
{/snippet}

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
    <!-- MOUNTED ONLY WHERE IT IS DRAWN. The panel is `hidden xl:flex`, and under `xl` - every phone -
         it was still mounted: a read of the stored conversations at boot and twenty rows, each
         segmenting its preview into graphemes. On the Mi 9T that was 45 ms of the main thread inside
         a tap on "Communautes" made as the app opened (CPU profile, 2026-10-15). -->
    {#if !overlayLayout()}
      <ConversationsMiniPanel />
    {/if}
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
        class="tap-target text-text-muted hover:text-text-main absolute top-1/2 right-3 -translate-y-1/2 transition-colors"
        aria-label={m.common_clear_aria()}
      >
        <X size={16} />
      </button>
    {/if}
  </div>

  <!-- ONE ROW: the three tabs and the CanaReels entry (user, 2026-10-16). Its content hides while a
       search replaces the feed; its margin stays, as it always did. -->
  <!-- COLLAPSING TAB ROW (a member, 2026-10-22: the tabs were only reachable at the very top). It is
       `sticky` to the page's scroller and moves by a TRANSFORM driven by `tabsShown` alone, so no
       layout changes and the feed neither jumps nor reflows. It is a direct child of the page column
       because a sticky box only sticks inside its parent. `inert` while hidden keeps it out of the
       tab order, and it never hides while focus is inside it (`tabsFocused`). `motion-reduce` drops
       the slide. While a search replaces the feed its content is hidden, so it is neither sticky
       nor padded. THE WRAPPER HAS NO BACKGROUND (owner, 2026-10-31): the row is a floating glass
       pill over the cards, and the gaps between its pieces are the feed's, so touches pass through. -->
  <div
    class="pointer-events-none mb-1 transition-transform duration-200 ease-out motion-reduce:transition-none [&_button]:pointer-events-auto {searchQuery
      ? ''
      : 'sticky top-0 z-10 pt-2 pb-3'} {tabsHidden ? '-translate-y-full' : ''}"
    inert={tabsHidden}
    onfocusin={() => (tabsFocused = true)}
    onfocusout={(e) => {
      const next = e.relatedTarget;
      tabsFocused = next instanceof Node && e.currentTarget.contains(next);
    }}
    data-feed-tabs-collapsible
  >
    <div class:hidden={!!searchQuery}>
      <FeedTabRow feed={activeFeed} onFeed={navigateFeed} {authToken} />
    </div>
  </div>

  <!-- THE LIVE CARD, at the top of the feed whatever the tab (L5); hidden while a search replaces
       the feed, like the tab row. Only where `livesShown` (the build AND the server's switch). -->
  {#if livesShown && userId && !searchQuery}
    <LiveFeedCard
      refreshKey={liveRefresh}
      viewerId={userId}
      onOpen={(live) => {
        Log.d('POSTS', `live ${live.id} opened from the feed card`);
        openLive = live;
      }}
    />
  {/if}
  {#if livesShown && openLive}
    {#key openLive.id}
      <LiveViewer
        live={openLive}
        onClose={() => {
          openLive = null;
          // A live that ended while watched leaves the card now, not at the next feed refresh.
          liveRefresh++;
        }}
      />
    {/key}
  {/if}

  {#if scheduledPosts.length > 0}
    <ScheduledPostsPanel posts={scheduledPosts} onDelete={deleteScheduled} />
    {#if scheduledDeleteError}
      <p class="text-red-err mb-4 text-sm" role="alert">{scheduledDeleteError}</p>
    {/if}
  {/if}

  <Modal
    open={showCreateModal}
    title={m.posts_new_post_title()}
    maxWidth="max-w-[42.5rem]"
    phoneFullScreen
    onClose={() => (showCreateModal = false)}
  >
    <CreatePostForm {onPostCreated} {onGoLive} />
  </Modal>

  <!-- THE LIVE REPLACES THE COMPOSER (owner, 2026-10-31): hosted HERE, not inside the composer, so
       the composer can close without ending it, and ending or closing the live leaves the feed. -->
  {#if liveTarget}
    <LiveOverlay
      associationId={liveTarget.associationId}
      associationName={liveTarget.associationName}
      onclose={() => {
        Log.d('POSTS', 'the live screen closed: back on the feed');
        liveTarget = null;
      }}
    />
  {/if}

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
              {@render guardedCard(post, () => {
                searchResults = (searchResults ?? []).filter((p) => p.id !== post.id);
              })}
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

      <!-- THE LIST IS THE DEVICE'S STORED COPY, NOT YET THE SERVER'S: said while it is refreshed, and
           after a refresh that got no answer, with a retry - never the error screen over posts the
           reader can read (local-first feed, `$lib/posts/feedStore`). -->
      {#if fromStore && !heldForLanding}
        <div class="text-text-muted mb-4 flex items-center gap-2 text-xs" role="status">
          {#if storedRefreshFailed && !loading}
            <span>{m.posts_stored_not_refreshed()}</span>
            <button
              type="button"
              class="tap-target ml-auto font-bold underline"
              onclick={refreshPosts}>{m.common_retry_button()}</button
            >
          {:else}
            <RefreshCw size={14} class="animate-spin opacity-60" />
            <span>{m.posts_stored_refreshing()}</span>
          {/if}
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
        {#if heldForLanding}
          {@render skeletonCards()}
        {:else if shownPosts}
          {@render feedList(shownPosts)}
        {:else}
          {#await data.posts}
            {@render skeletonCards()}
          {:then}
            <!-- The answer's handler sets `shownPosts` in this same turn; the list is drawn by the
                 branch above, ONE block, so it does not mount here and again there. -->
            {@render skeletonCards()}
          {:catch err}
            <!-- A stored copy still being read is about to draw: no error screen flashes before it. -->
            {#if loading || storedReadPending}
              {@render skeletonCards()}
            {:else if noAudience || isFeedAudienceRefusal(err)}
              <div
                class="border-cn-border bg-cn-surface rounded-3xl border border-dashed px-6 py-16 text-center"
              >
                <Inbox size={48} class="text-text-muted mx-auto mb-3 opacity-40" />
                <h3 class="text-text-main mb-1 text-lg font-bold">
                  {m.posts_no_audience_title()}
                </h3>
                <p class="text-text-muted text-sm">{m.posts_no_audience_hint()}</p>
              </div>
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
        <!-- A REFRESH DOES NOT BLANK A FEED THAT IS ALREADY ON SCREEN. This was `{#if loading}`,
             so a pull-to-refresh at post #30 collapsed the list to four skeletons, shrank the
             document and lost the reader's place - for posts still held in `postsOverride`. Same
             rule as `ChatArea.svelte`'s `showSkeleton`: the skeleton is for an empty list. -->
        {#if loading && resolvedPosts.length === 0}
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
                  class="tap-target font-medium underline"
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
          {#each resolvedPosts.slice(0, mounted.count) as post (post.id)}
            <div class="relative" use:markPostSeen={post}>
              {#if isNew(post)}
                <PostCornerBadge label={m.posts_badge_new()} />
              {/if}
              {@render guardedCard(post, () => {
                postsOverride = resolvedPosts.filter((p) => p.id !== post.id);
                writeFeedCache(feedCacheKey(data.feedParams), {
                  posts: postsOverride,
                  hasMore,
                });
                // The next launch must not draw the post just deleted from the stored page.
                storeFirstPage(data.feedParams, postsOverride.slice(0, FEED_FIRST_PAGE_SIZE));
              })}
            </div>
          {/each}

          <!-- Infinite-scroll sentinel - only once every card is mounted: under the third card it
               would sit in view and fetch the next page at once. -->
          {#if mounted.complete}
            <div bind:this={sentinel} class="h-4"></div>
          {/if}

          {#if loadingMore}
            <div class="flex justify-center py-4">
              <RefreshCw size={20} class="text-text-muted animate-spin opacity-50" />
            </div>
          {:else if !hasMore && !fromStore && resolvedPosts.length >= FEED_PAGE_SIZE}
            <p class="text-text-muted text-2xs py-4 text-center opacity-50">
              {m.posts_all_loaded()}
            </p>
          {/if}
        {/if}
      {/snippet}
    {/if}
  </section>
</PageContainer>
