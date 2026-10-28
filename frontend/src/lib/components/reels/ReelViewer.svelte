<script lang="ts">
  /**
   * THE FULL-SCREEN VERTICAL REEL VIEWER (C7): the touched reel first, then the reels the server
   * lists, one per screen. Drag up for the next, down for the previous, right (or Back, or the X) to
   * close. The current reel plays with the app's one sound answer and loops; the next one preloads.
   *
   * Every decision - what a release means, where it leads, what is mounted, when the next page is
   * asked for - is `reels/reelViewerNav.ts`, on the media viewer's own gesture math. This file
   * measures the finger and moves ONE track: the reels sit one screen apart inside it, so a swipe is
   * a single transform whose own `transitionend` says when it has landed - never a timer.
   *
   * IT IS A HISTORY ENTRY (`bindHistoryOverlay`), so Android's Back closes it, and it covers the
   * screen (`coversScreen`), so the iOS native tab bar steps aside.
   *
   * THE RAIL AND THE COMMENTS SHEET (user, 2026-10-19, Instagram's Reels): each page of a post gets
   * the heart, the comments and the send (`ReelActionRail`); the comments open over the playing
   * reel (`ReelCommentsSheet`). A conversation's reel is not a post and gets neither - the rail is
   * drawn only for a signed-in reader (`likerId`). A dialog opened from in here (a report, the GIF
   * picker) is drawn above the viewer (`markViewerLayer`).
   */
  import { onMount } from 'svelte';
  import { themeStore } from '$lib/stores/themeStore.svelte';
  import { ChevronDown, ChevronUp, X } from '@lucide/svelte';
  import ReelSlide from './ReelSlide.svelte';
  import ReelCommentsSheet from './ReelCommentsSheet.svelte';
  import { markViewerLayer } from '$lib/utils/viewerLayer';
  import { pickedReactionToggle, railHeartToggle, type ReelRailActions } from '$lib/reels/reelRail';
  import { WheelPageLock, wheelOverScrollable, wheelStep } from '$lib/reels/reelWheel';
  import { portal } from '$lib/actions/portal';
  import { coversScreen } from '$lib/actions/coversScreen.svelte';
  import type { PostEntity } from '$lib/posts/api';
  import { REEL_PAGE as PAGE, listAllReels, type ReelPageLoader } from '$lib/reels/allReels';
  import {
    mergeReelPage,
    mountedReelIndices,
    reelDragOffset,
    reelReleaseVerdict,
    shouldLoadMoreReels,
    stepReelIndex,
    type ReelSwipeVerdict,
  } from '$lib/reels/reelViewerNav';
  import {
    GESTURE,
    classifyMove,
    releaseVelocity,
    type GestureKind,
    type Sample,
  } from '$lib/utils/viewerGestures';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { claimTouchMove } from '$lib/utils/touchClaim';
  import {
    DOUBLE_TAP_REACTION,
    publishPostReactions,
    reactionRefusedLocally,
    sendPostReaction,
    toggledReactions,
    type PostReactions,
  } from '$lib/posts/postReaction';
  import { publishFailureMessage } from '$lib/posts/publishFailure';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The reel shown first: the one touched, or the newest when opened from the feed's icon. */
    startPost: PostEntity;
    authToken: string;
    onClose: () => void;
    /** The next page of reels: the C7 list (`reels/allReels.ts`) unless the opener has its own. */
    loadPage?: ReelPageLoader;
    /**
     * The signed-in reader, whose double tap on a reel likes it. Absent, a double tap does nothing:
     * a conversation's reel is not a post, and has no reactions to give.
     */
    likerId?: string;
  }

  let { startPost, authToken, onClose, loadPage = listAllReels, likerId }: Props = $props();

  /**
   * Touches on these belong to them: the player's bar seeks, a button is pressed, and an EXPANDED
   * caption scrolls its own text (`ReelSlide`) - a swipe there must not turn the reel.
   */
  const NOT_A_GESTURE =
    'button, [data-video-controls], [data-reel-caption-open], [data-reel-rail], [data-comments-drawer]';

  markViewerLayer();

  let reels = $state<PostEntity[]>([]);
  let index = $state(0);
  /** How many rows the server has handed over so far - the next page's offset. */
  let fetched = 0;
  let hasMore = $state(true);
  let loadingMore = false;

  let frame = $state<HTMLDivElement | null>(null);
  let offsetX = $state(0);
  let offsetY = $state(0);
  let settling = $state(false);
  let afterSettle: (() => void) | null = null;

  const overlay = bindHistoryOverlay(
    () => true,
    () => {
      console.debug('[reel-viewer] closed');
      onClose();
    }
  );

  onMount(() => {
    // The viewer paints black under the status bar: light icons while it is up, handed back after.
    const releaseBar = themeStore.holdNativeBar('dark');
    reels = [startPost];
    overlay.syncOpen();
    console.debug(`[reel-viewer] opened on ${startPost.id}`);
    return releaseBar;
  });

  const mounted = $derived(mountedReelIndices(index, reels.length));

  // The next page, asked for as the reader nears the end of what is loaded.
  $effect(() => {
    if (!shouldLoadMoreReels(index, reels.length, hasMore) || loadingMore || reels.length === 0) {
      return;
    }
    void loadMore();
  });

  async function loadMore() {
    loadingMore = true;
    try {
      const page = await loadPage(fetched, PAGE);
      fetched += page.length;
      if (page.length < PAGE) hasMore = false;
      reels = mergeReelPage(reels, page);
      console.debug(`[reel-viewer] page of ${page.length}, ${reels.length} loaded`);
    } catch (err) {
      // The reels already loaded stay watchable; the list simply ends here.
      console.error('[reel-viewer] the next reels could not be loaded', err);
      hasMore = false;
      showToast(m.reels_viewer_load_error(), 'error');
    } finally {
      loadingMore = false;
    }
  }

  /** Replaces the reactions of the loaded reel `postId`, wherever it now sits in the list. */
  function setReactions(postId: string, reactions: PostReactions) {
    reels = reels.map((r) => (r.id === postId ? { ...r, reactions } : r));
  }

  /**
   * The posts whose reaction is on its way to the server. ONE AT A TIME PER POST: a second tap
   * while the first is in flight is ignored (logged), so two answers can never land out of order,
   * and a failure rolls back to the state the tap started from, which no later tap has moved.
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a guard read by handlers, never rendered
  const reactionInFlight = new Set<string>();

  /**
   * Sends the reader's reaction `type` on `post` (taking it back when `wasReacted`) on the card's
   * path (`posts/postReaction.ts`): written on the tap, the server's answer adopted and announced to
   * the cards behind, a failure rolled back and said as the card's sentence in a toast.
   */
  function sendReaction(post: PostEntity, me: string, type: string, wasReacted: boolean) {
    const before = post.reactions ?? {};
    reactionInFlight.add(post.id);
    setReactions(post.id, toggledReactions(before, me, type).next);
    sendPostReaction(post.id, type, wasReacted)
      .then(
        (reactions) => {
          setReactions(post.id, reactions);
          publishPostReactions(post.id, reactions);
        },
        (err: unknown) => {
          console.warn(`[reel-viewer] the reaction on ${post.id} was not recorded`, err);
          setReactions(post.id, before);
          showToast(publishFailureMessage(err, m.post_reaction_error()), 'error');
        }
      )
      .finally(() => reactionInFlight.delete(post.id));
  }

  /**
   * A DOUBLE TAP ON A REEL LIKES IT, AND NEVER UNLIKES IT (user, 2026-10-19), on `sendReaction`.
   * A reel the reader already reacted to, with any reaction, gets the heart and no request. True
   * when the reel now carries the reader's reaction, which is when the heart is drawn.
   */
  function likeReel(post: PostEntity): boolean {
    const me = likerId;
    if (!me) return false;
    if ((post.reactions ?? {})[me]) {
      console.debug(`[reel-viewer] double tap on ${post.id}: already reacted, heart only`);
      return true;
    }
    if (reactionInFlight.has(post.id)) {
      console.debug(`[reel-viewer] double tap on ${post.id}: a reaction is in flight, ignored`);
      return false;
    }
    if (reactionRefusedLocally()) {
      console.debug(`[reel-viewer] double tap on ${post.id}: refused, the reader is muted`);
      showToast(m.post_action_not_allowed(), 'error');
      return false;
    }
    console.debug(`[reel-viewer] double tap on ${post.id}: like`);
    sendReaction(post, me, DOUBLE_TAP_REACTION, false);
    return true;
  }

  /**
   * THE RAIL'S HEART (`reels/reelRail.ts`): it takes the reader's reaction back if they hold one,
   * and gives "J'aime" if not - the card's toggle, on `sendReaction`.
   */
  function toggleHeart(post: PostEntity) {
    const me = likerId;
    if (!me) return;
    if (reactionInFlight.has(post.id)) {
      console.debug(`[reel-viewer] heart on ${post.id}: a reaction is in flight, ignored`);
      return;
    }
    if (reactionRefusedLocally()) {
      console.debug(`[reel-viewer] heart on ${post.id}: refused, the reader is muted`);
      showToast(m.post_action_not_allowed(), 'error');
      return;
    }
    const { type, wasReacted } = railHeartToggle(post.reactions ?? {}, me);
    console.debug(`[reel-viewer] heart on ${post.id}: ${wasReacted ? 'take back' : 'like'}`);
    sendReaction(post, me, type, wasReacted);
  }

  /**
   * A PICK IN THE HEART'S DRAWER (long press): the card's picker - a kind the reader does not hold
   * replaces theirs, the one they hold is taken back. Same guards as the heart.
   */
  function pickReaction(post: PostEntity, type: string) {
    const me = likerId;
    if (!me) return;
    if (reactionInFlight.has(post.id)) {
      console.debug(`[reel-viewer] drawer pick on ${post.id}: a reaction is in flight, ignored`);
      return;
    }
    if (reactionRefusedLocally()) {
      console.debug(`[reel-viewer] drawer pick on ${post.id}: refused, the reader is muted`);
      showToast(m.post_action_not_allowed(), 'error');
      return;
    }
    const pick = pickedReactionToggle(post.reactions ?? {}, me, type);
    console.debug(`[reel-viewer] drawer pick ${type} on ${post.id}`);
    sendReaction(post, me, pick.type, pick.wasReacted);
  }

  /** The post whose comments sheet is open, by id - the sheet follows the row, not an index. */
  let commentsFor = $state<string | null>(null);
  /** The sheet has begun to slide out: the reel grows back to the screen with it. */
  let commentsLeaving = $state(false);
  /** The reel is a rounded card above the sheet (Instagram's): `scale` of the full screen. */
  const commentsCard = $derived(commentsFor !== null && !commentsLeaving);
  const commentsPost = $derived(
    commentsFor ? (reels.find((r) => r.id === commentsFor) ?? null) : null
  );

  /**
   * The post whose share sheet is open (the rail's send), by id. The sheet (`PostShareSheet`) is
   * loaded on the first send, never with the viewer: it reads the conversation list, which a
   * viewer opened only to watch has no reason to load. Drawn inside the viewer, so its dialogs
   * take the viewer's rung (`markViewerLayer`).
   */
  let shareFor = $state<string | null>(null);
  let ShareSheet = $state<
    typeof import('$lib/components/posts/PostShareSheet.svelte').default | null
  >(null);

  function openShareSheet(postId: string) {
    import('$lib/components/posts/PostShareSheet.svelte')
      .then((mod) => {
        ShareSheet = mod.default;
        shareFor = postId;
      })
      .catch((e: unknown) => console.error('[reel-viewer] the share sheet did not load', e));
  }

  /** Replaces the loaded post `next.id` - a comment written in the sheet. */
  function setPost(next: PostEntity) {
    reels = reels.map((r) => (r.id === next.id ? next : r));
  }

  /** The rail's actions for one page, or none outside a signed-in reader's posts. */
  function railFor(post: PostEntity): ReelRailActions | undefined {
    const me = likerId;
    if (!me) return undefined;
    return {
      readerId: me,
      onHeart: () => toggleHeart(post),
      onReact: (type) => pickReaction(post, type),
      onComments: () => {
        console.debug(`[reel-viewer] comments opened on ${post.id}`);
        commentsLeaving = false;
        commentsFor = post.id;
      },
      onSend: () => openShareSheet(post.id),
    };
  }

  function reducedMotion(): boolean {
    return (
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  /**
   * Moves the track to the given offset with the snap transition, then runs `then` once it has
   * landed. A move that changes nothing, or a reader who asked for reduced motion, runs `then` at
   * once - a transition that does not happen fires no end event.
   */
  function settle(x: number, y: number, then?: () => void) {
    // A LANDING IS NEVER DROPPED: a move started over one still pending (every entry point waits for
    // `settling` to clear, so this is a defect upstream) runs it first, and says so.
    if (afterSettle) {
      console.error('[reel-viewer] a move started over a pending landing - the landing runs first');
      const pending = afterSettle;
      afterSettle = null;
      pending();
    }
    if (reducedMotion() || (x === offsetX && y === offsetY)) {
      offsetX = x;
      offsetY = y;
      settling = false;
      afterSettle = null;
      then?.();
      return;
    }
    settling = true;
    afterSettle = then ?? null;
    offsetX = x;
    offsetY = y;
  }

  /**
   * The track's move is over: it ENDED, or it was CANCELLED (the track hidden or detached mid-move,
   * where `transitionend` never comes - and `settling` would freeze touch, keys, wheel and
   * chevrons until the viewer closed). Either way the landing runs, which puts the page at rest
   * where the move was going.
   */
  function onTransitionEnd(e: TransitionEvent) {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
    if (e.type === 'transitioncancel') {
      console.warn('[reel-viewer] the track move was cancelled - landing where it was going');
    }
    settling = false;
    const next = afterSettle;
    afterSettle = null;
    next?.();
  }

  /** Carries out a verdict: the track leaves towards it, then the index moves and the track rests. */
  function go(verdict: ReelSwipeVerdict) {
    const height = frame?.clientHeight ?? window.innerHeight;
    const width = frame?.clientWidth ?? window.innerWidth;
    const target = stepReelIndex(index, verdict, reels.length);
    if (verdict === 'close') {
      console.debug('[reel-viewer] closed by a swipe');
      settle(width, 0, () => overlay.dismissFromUi());
      return;
    }
    if (target === index) {
      settle(0, 0);
      return;
    }
    console.debug(`[reel-viewer] ${verdict}: ${index} -> ${target}`);
    settle(0, verdict === 'next' ? -height : height, () => {
      // The track has landed one screen away; moving the index there is the same picture at rest.
      settling = false;
      index = target;
      offsetY = 0;
    });
  }

  let viewerEl = $state<HTMLDivElement | null>(null);

  /**
   * THE MOUSE WHEEL TURNS THE PAGE (user, 2026-10-19, desktop): one gesture, one page, through
   * `go` - the arrow buttons' path (`reels/reelWheel.ts`). Not while the comments sheet is open nor
   * over a child that scrolls (the list scrolls instead), never on ctrl+wheel (zoom) or a horizontal
   * scroll. Non-passive, on the viewer only, so `preventDefault` runs exactly when the event is
   * consumed; removed with the viewer.
   */
  $effect(() => {
    const el = viewerEl;
    if (!el) return;
    const lock = new WheelPageLock();
    function onWheel(e: WheelEvent) {
      const step = wheelStep(e);
      if (!step || commentsFor || shareFor || wheelOverScrollable(e.target, el!)) return;
      e.preventDefault();
      // Free when the wheel was quiet AND the last page has landed (`settling` clears on landing).
      const free = lock.free && !settling;
      lock.heard();
      if (!free) return;
      console.debug(`[reel-viewer] wheel: ${step}`);
      go(step);
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      lock.dispose();
    };
  });

  // Touch listeners by hand with `passive: false`: Svelte registers touch handlers as passive, where
  // `preventDefault()` is ignored and the page would scroll under the drag.
  $effect(() => {
    const el = frame;
    if (!el) return;
    let gesture: GestureKind | null = null;
    let start: Sample = { x: 0, y: 0, t: 0 };
    let samples: Sample[] = [];
    const sampleOf = (t: Touch, time: number): Sample => ({ x: t.clientX, y: t.clientY, t: time });

    function onStart(e: TouchEvent) {
      if ((e.target as HTMLElement).closest(NOT_A_GESTURE) || settling) {
        gesture = null;
        return;
      }
      gesture = e.touches.length >= 2 ? 'pinch' : 'pending';
      start = sampleOf(e.touches[0], e.timeStamp);
      samples = [start];
    }

    function onMove(e: TouchEvent) {
      if (!gesture || gesture === 'pinch' || e.touches.length !== 1) return;
      const now = sampleOf(e.touches[0], e.timeStamp);
      samples.push(now);
      if (samples.length > 12) samples.shift();
      const dx = now.x - start.x;
      const dy = now.y - start.y;
      if (gesture === 'pending') {
        // Classified ONCE, then kept until the finger lifts: a swipe that curves stays a swipe.
        gesture = classifyMove({ dx, dy, zoomed: false, touches: 1 });
        if (gesture === 'pending') return;
      }
      // A move the engine is already scrolling is not ours: the drag stands down and springs back.
      if (!claimTouchMove(e)) {
        gesture = null;
        settle(0, 0);
        return;
      }
      const o = reelDragOffset(gesture, dx, dy, index > 0, index < reels.length - 1);
      offsetX = o.x;
      offsetY = o.y;
    }

    function onEnd(e: TouchEvent) {
      if (!gesture || e.touches.length > 0) return;
      const kind = gesture;
      gesture = null;
      if (kind === 'pending' || kind === 'pinch') return;
      const end = sampleOf(e.changedTouches[0], e.timeStamp);
      samples.push(end);
      go(
        reelReleaseVerdict({
          kind,
          dx: end.x - start.x,
          dy: end.y - start.y,
          velocity: releaseVelocity(samples),
          width: el!.clientWidth,
          height: el!.clientHeight,
          hasPrevious: index > 0,
          hasNext: index < reels.length - 1,
        })
      );
    }

    // A cancel ends a drag of OURS; one arriving while a page lands (no drag was taken) moves nothing.
    function onCancel() {
      if (!gesture) return;
      gesture = null;
      settle(0, 0);
    }

    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('touchcancel', onCancel);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
    };
  });

  /** How far one arrow key scrolls an unfolded caption: about two lines of its text. */
  const CAPTION_LINE_STEP = 40;

  /**
   * While the current reel's caption is UNFOLDED (`ReelSlide`, `data-reel-caption-open`), the up and
   * down keys scroll ITS text, as a drag there does, instead of turning the reel. True when it took
   * the key.
   */
  function scrollOpenCaption(e: KeyboardEvent): boolean {
    const down = e.key === 'ArrowDown' || e.key === 'PageDown';
    const up = e.key === 'ArrowUp' || e.key === 'PageUp';
    if (!down && !up) return false;
    const caption = frame?.querySelector<HTMLElement>('[data-reel-caption-open]');
    if (!caption) return false;
    e.preventDefault();
    const step = e.key.startsWith('Page') ? caption.clientHeight * 0.9 : CAPTION_LINE_STEP;
    caption.scrollBy({ top: down ? step : -step });
    return true;
  }

  /** The keyboard: up/down page, Escape closes. A key the player already used is left to it. */
  function onKeydown(e: KeyboardEvent) {
    // The comments sheet has the keyboard while it is open: its field types, and Escape closes IT.
    if (e.defaultPrevented || settling || commentsFor || shareFor) return;
    if (scrollOpenCaption(e)) return;
    if (e.key === 'ArrowDown' || e.key === 'PageDown') {
      e.preventDefault();
      go('next');
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault();
      go('prev');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      overlay.dismissFromUi();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div use:portal>
  <div
    bind:this={viewerEl}
    use:coversScreen
    class="fixed inset-0 z-(--z-viewer) overflow-hidden bg-black text-white"
    role="dialog"
    aria-modal="true"
    aria-label={m.reels_viewer_label()}
    data-reel-viewer
  >
    <!-- THE REEL SHRINKS INTO A CARD while the comments are open (transform only, the motion scale of
         design-reference "Motion"; the global reduced-motion rule makes it instant). The corner radius is
         set at once, not animated, and is drawn at the card's scale, so it reads about 12 px. -->
    <div
      bind:this={frame}
      class="absolute inset-0 touch-none {commentsCard ? 'overflow-hidden rounded-3xl' : ''}"
      style:transform-origin="50% 0"
      style:transform={commentsCard
        ? 'translate3d(0, calc(var(--safe-area-inset-top, 0px) + 0.75rem), 0) scale(0.34)'
        : 'none'}
      style:transition="transform var(--motion-slow) var(--motion-ease-out)"
      data-reel-card={commentsCard}
    >
      <div
        class="absolute inset-0"
        style:transform="translate3d({offsetX}px, calc({-index * 100}% + {offsetY}px), 0)"
        style:transition={settling
          ? `transform ${GESTURE.SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`
          : 'none'}
        ontransitionend={onTransitionEnd}
        ontransitioncancel={onTransitionEnd}
        data-reel-track
      >
        {#each mounted as i (reels[i].id)}
          <div class="absolute inset-x-0 h-full" style:top="{i * 100}%">
            <ReelSlide
              post={reels[i]}
              {authToken}
              active={i === index}
              preload={i === index + 1}
              onLike={likerId ? () => likeReel(reels[i]) : undefined}
              rail={railFor(reels[i])}
            />
          </div>
        {/each}
      </div>
    </div>

    <!-- THE TOP SCRIM (user, 2026-10-23: the status bar icons vanished on black) lies under the
         close button and the phone's status bar, so white icons read on a bright reel too; the
         native icons themselves are held light (`holdNativeBar`). The X has no disc: a disc
         against a letterboxed frame's rounded corner read as overlapping it. Safe-area aware. -->
    <div
      class="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-linear-to-b from-black/50 to-transparent px-2 pt-[calc(var(--safe-area-inset-top,0px)+0.5rem)] pb-6"
      data-reel-top-scrim
    >
      <button
        type="button"
        class="ui-icon-button pointer-events-auto rounded-full outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        aria-label={m.reels_viewer_close()}
        title={m.reels_viewer_close()}
        onclick={() => overlay.dismissFromUi()}
      >
        <X size={26} strokeWidth={2.5} class="drop-shadow-md" />
      </button>
    </div>

    <!-- A pointer has no swipe: the two steps are buttons on a wide screen. -->
    <div
      class="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 flex-col gap-2 md:flex"
    >
      <button
        type="button"
        class="ui-icon-button pointer-events-auto rounded-full bg-white/15 outline-none hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-30"
        aria-label={m.reels_viewer_prev()}
        title={m.reels_viewer_prev()}
        disabled={index === 0}
        onclick={() => !settling && go('prev')}
      >
        <ChevronUp size={22} strokeWidth={2.5} />
      </button>
      <button
        type="button"
        class="ui-icon-button pointer-events-auto rounded-full bg-white/15 outline-none hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-30"
        aria-label={m.reels_viewer_next()}
        title={m.reels_viewer_next()}
        disabled={index >= reels.length - 1}
        onclick={() => !settling && go('next')}
      >
        <ChevronDown size={22} strokeWidth={2.5} />
      </button>
    </div>

    {#if commentsPost && likerId}
      <ReelCommentsSheet
        post={commentsPost}
        currentUserId={likerId}
        {authToken}
        onChange={setPost}
        onClosing={() => (commentsLeaving = true)}
        onClose={() => {
          commentsFor = null;
          commentsLeaving = false;
        }}
      />
    {/if}

    {#if ShareSheet && shareFor}
      <ShareSheet
        open
        postId={shareFor}
        onClose={() => (shareFor = null)}
        onSentInApp={() => {
          // The link waits in a conversation's composer, under this viewer: step aside for it.
          console.debug('[reel-viewer] closed: the reel was sent into a conversation');
          overlay.dismissFromUi();
        }}
      />
    {/if}
  </div>
</div>
