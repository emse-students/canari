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
   */
  import { onMount } from 'svelte';
  import { ChevronDown, ChevronUp, X } from '@lucide/svelte';
  import ReelSlide from './ReelSlide.svelte';
  import { portal } from '$lib/actions/portal';
  import { coversScreen } from '$lib/actions/coversScreen.svelte';
  import { listPosts, type PostEntity } from '$lib/posts/api';
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
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The reel that was touched: shown first. */
    startPost: PostEntity;
    authToken: string;
    onClose: () => void;
    /** The next page of reels; injectable for tests. */
    loadPage?: (offset: number, limit: number) => Promise<PostEntity[]>;
  }

  let {
    startPost,
    authToken,
    onClose,
    loadPage = (offset, limit) => listPosts({ kind: 'reel', feed: 'all', offset, limit }),
  }: Props = $props();

  /** How many reels one page asks for. */
  const PAGE = 10;
  /** Touches on these belong to them: the player's bar seeks, a button is pressed. */
  const NOT_A_GESTURE = 'button, [data-video-controls]';

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
    reels = [startPost];
    overlay.syncOpen();
    console.debug(`[reel-viewer] opened on ${startPost.id}`);
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

  function onTransitionEnd(e: TransitionEvent) {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
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

    function onCancel() {
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

  /** The keyboard: up/down page, Escape closes. A key the player already used is left to it. */
  function onKeydown(e: KeyboardEvent) {
    if (e.defaultPrevented || settling) return;
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
    use:coversScreen
    class="fixed inset-0 z-(--z-viewer) overflow-hidden bg-black text-white"
    role="dialog"
    aria-modal="true"
    aria-label={m.reels_viewer_label()}
    data-reel-viewer
  >
    <div bind:this={frame} class="absolute inset-0 touch-none">
      <div
        class="absolute inset-0"
        style:transform="translate3d({offsetX}px, calc({-index * 100}% + {offsetY}px), 0)"
        style:transition={settling
          ? `transform ${GESTURE.SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`
          : 'none'}
        ontransitionend={onTransitionEnd}
        data-reel-track
      >
        {#each mounted as i (reels[i].id)}
          <div class="absolute inset-x-0 h-full" style:top="{i * 100}%">
            <ReelSlide post={reels[i]} {authToken} active={i === index} preload={i === index + 1} />
          </div>
        {/each}
      </div>
    </div>

    <div
      class="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3 pt-[calc(var(--safe-area-inset-top,0px)+0.75rem)]"
    >
      <button
        type="button"
        class="ui-icon-button pointer-events-auto rounded-full bg-black/30 outline-none hover:bg-black/50 focus-visible:ring-2 focus-visible:ring-amber-500"
        aria-label={m.reels_viewer_close()}
        title={m.reels_viewer_close()}
        onclick={() => overlay.dismissFromUi()}
      >
        <X size={24} strokeWidth={2.5} />
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
        onclick={() => go('prev')}
      >
        <ChevronUp size={22} strokeWidth={2.5} />
      </button>
      <button
        type="button"
        class="ui-icon-button pointer-events-auto rounded-full bg-white/15 outline-none hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-30"
        aria-label={m.reels_viewer_next()}
        title={m.reels_viewer_next()}
        disabled={index >= reels.length - 1}
        onclick={() => go('next')}
      >
        <ChevronDown size={22} strokeWidth={2.5} />
      </button>
    </div>
  </div>
</div>
