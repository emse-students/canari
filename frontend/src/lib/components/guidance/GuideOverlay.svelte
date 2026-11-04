<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { afterNavigate, beforeNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { ChevronsRight } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { portal } from '$lib/actions/portal';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';
  import { screenCover } from '$lib/actions/coversScreen.svelte';
  import { globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
  import { getKeyboardViewport } from '$lib/stores/keyboardViewport.svelte';
  import {
    isBelowMinClientVersion,
    isMaintenanceBlockingCurrentUser,
  } from '$lib/stores/appVersionCheck.svelte';
  import { modalWebLayer, nativeTabBar } from '$lib/navigation/nativeTabBarState.svelte';
  import { isFullScreenPlace } from '$lib/navigation/places';
  import { isIosTauriRuntime } from '$lib/utils/appVersion';
  import {
    onHistoryOverlayDepthChange,
    pushHistoryOverlay,
    releaseHistoryOverlay,
    historyOverlayStackDepth,
    type OverlayClose,
  } from '$lib/utils/historyOverlayStack';
  import { onViewportChange, PHONE_VIEWPORT_QUERY, SWIPE_NAV_QUERY } from '$lib/utils/viewport';
  import { Log } from '$lib/utils/Log';
  import { guideEngine, noteSettledPath } from '$lib/guidance/guidance.svelte';
  import { resolveGuideAnchor } from '$lib/guidance/guideAnchors.svelte';
  import { seenHelps } from '$lib/guidance/seenHelps.svelte';
  import { quietBlocker } from '$lib/guidance/guideQuiet';
  import { placeBubble, type BubblePosition } from '$lib/guidance/guidePlacement';
  import type { GuideRect } from '$lib/guidance/guideAnchors.svelte';

  /**
   * THE ONE RENDERER OF EVERY GUIDED TOUR AND FIRST-TIME HINT (docs/wiki/frontend/guided-help.md):
   * the spotlight and its halo on the real control, and the bubble with "n/N", Next and "Passer".
   * Mounted once, by the root layout. It holds no help of its own - `guideEngine` decides which help
   * and which step; this file decides only WHEN it may be on screen (the quiet state) and how it is
   * drawn, reached and closed.
   *
   * - FOCUS moves into the bubble on every step, Tab stays inside it (`focusTrap`), Esc and "Passer"
   *   end the help, the arrow keys step, and a polite live region announces each step.
   * - BACK closes it like every overlay: its entry is on the history stack while it is on screen, and
   *   leaves it (a ghost, no traversal) when it is hidden or ended - `historyOverlayStack.ts`.
   * - A TOUR IS MODAL: a layer under the bubble takes every pointer, so the page cannot be used
   *   behind it. A HINT is not: nothing but the bubble takes a pointer.
   * - MOTION is the halo's breath, the spotlight gliding between controls and the bubble's entrance,
   *   all CSS - so `prefers-reduced-motion` (the global rule in `app.css`) stops them, and this file
   *   additionally drops the infinite ones and smooth scrolling when it is set.
   */
  interface Props {
    /** The layout's own "no app chrome here" (login, legal pages, a public form). */
    chromeless: boolean;
  }

  let { chromeless }: Props = $props();

  const pathname = $derived(page.url.pathname);

  /** The route `afterNavigate` last settled - every component of it has mounted and run its actions. */
  let settledPath = $state('');
  /** Overlays on the history stack, ours included (see `ownEntries`). */
  let stackDepth = $state(historyOverlayStackDepth());
  /** 1 while this overlay's own entry is on the stack. */
  let ownEntries = $state(0);
  let reducedMotion = $state(false);

  const callActive = $derived(globalSession.callState !== 'idle');
  const gated = $derived(
    isBelowMinClientVersion() || isMaintenanceBlockingCurrentUser(isGlobalAdmin())
  );
  const isIosApp = isIosTauriRuntime();

  const blocker = $derived(
    quietBlocker({
      signedIn: globalSession.isLoggedIn,
      authPage: chromeless,
      fullScreenPlace: isFullScreenPlace(pathname),
      screenCovered: screenCover.covered,
      callActive,
      keyboardOpen: getKeyboardViewport().isOpen,
      otherOverlays: Math.max(0, stackDepth - ownEntries),
      routeSettled: settledPath === pathname,
      gated,
      nativeBarPending: isIosApp && nativeTabBar.status === 'pending',
    })
  );

  const view = $derived(guideEngine.view);
  /** On screen: a step to draw and a quiet app. Hidden otherwise - suspended, never ended. */
  const visible = $derived(view !== null && blocker === null);
  // A modal step's backdrop is on screen: the iOS native tab bar, drawn above the WebView, must
  // take no touch meanwhile (`modalWebLayer`, read by `NativeTabBar`).
  $effect(() => {
    modalWebLayer.covering = visible && view?.modal === true;
    return () => (modalWebLayer.covering = false);
  });

  // Says what a help waits for, once per change: the line a reader of the log needs and nothing more.
  let lastBlocker: string | null = null;
  $effect(() => {
    const reason = blocker;
    if (reason === lastBlocker) return;
    lastBlocker = reason;
    if (guideEngine.activeId || guideEngine.requestedId) {
      Log.d('guide', reason ? `on hold: ${reason}` : 'the app is quiet');
    }
  });

  // The account's seen set: the local copy at once, the server's as soon as there is an account.
  $effect(() => {
    const userId = currentUserId();
    if (userId) void seenHelps.load(userId);
  });

  // THE SCHEDULER: re-asked on every change of the quiet state, the route, the seen set and the
  // anchors (all read inside `consider`) - the event that made the app quiet is what starts a help.
  $effect(() => {
    guideEngine.consider(blocker === null, pathname);
  });

  beforeNavigate(({ shallow, type }) => {
    if (shallow && type === 'goto') return;
    settledPath = '';
  });

  afterNavigate(async ({ shallow, type, to }) => {
    if (shallow && type === 'goto') return;
    // After the flush, so the anchors of the page that just mounted are all registered.
    await tick();
    const path = to?.url.pathname ?? page.url.pathname;
    settledPath = path;
    noteSettledPath(path);
  });

  onMount(() => {
    const stopDepth = onHistoryOverlayDepthChange((depth) => (stackDepth = depth));
    const relayout = () => guideEngine.layoutChanged();
    const stopPhone = onViewportChange(PHONE_VIEWPORT_QUERY, relayout);
    const stopSwipe = onViewportChange(SWIPE_NAV_QUERY, relayout);
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    reducedMotion = motion?.matches ?? false;
    const onMotion = (e: MediaQueryListEvent) => (reducedMotion = e.matches);
    motion?.addEventListener('change', onMotion);
    return () => {
      stopDepth();
      stopPhone();
      stopSwipe();
      motion?.removeEventListener('change', onMotion);
    };
  });

  // ---- Back: the help's own history entry, present exactly while it is on screen. -------------
  let entry: OverlayClose | null = null;

  $effect(() => {
    const shown = visible;
    untrack(() => {
      if (shown && !entry) {
        const close: OverlayClose = (reason) => {
          // The stack has already taken the entry off: only the help is left to end.
          entry = null;
          ownEntries = 0;
          guideEngine.end(reason === 'navigation' ? 'navigation' : 'back');
        };
        entry = close;
        ownEntries = 1;
        pushHistoryOverlay(close);
      } else if (!shown && entry) {
        // Ended from the bubble, or suspended: the entry stays as a ghost, as every UI close does.
        releaseHistoryOverlay(entry);
        entry = null;
        ownEntries = 0;
      }
    });
  });

  $effect(() => () => {
    if (entry) releaseHistoryOverlay(entry);
    entry = null;
  });

  // ---- Geometry: where the target is, and where the bubble goes. ------------------------------
  let bubbleEl = $state<HTMLElement | null>(null);
  let targetRect = $state<GuideRect | null>(null);
  let bubblePos = $state<BubblePosition | null>(null);
  /**
   * True while the page scrolls under the help: the spotlight and the bubble then follow the target
   * with NO transition (a glide would lag the finger). Set by a scroll, cleared by `scrollend` and
   * by the next step - the glide is for moving between steps only.
   */
  let tracking = $state(false);

  /** One rem in px, so the paddings below follow the root font size like every token. */
  function rem(): number {
    return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  }

  /** Re-reads the target's box and places the bubble. Called on every event that can move either. */
  function measure(): void {
    const current = guideEngine.view;
    if (!current || !bubbleEl) return;
    const anchor = current.anchorId ? resolveGuideAnchor(current.anchorId) : null;
    if (current.anchorId && !anchor) {
      // Rendered when the step was entered, gone now (a breakpoint crossed): the engine moves on.
      guideEngine.layoutChanged();
      return;
    }
    const rect = anchor?.rect() ?? null;
    const pad = 0.375 * rem();
    targetRect = rect
      ? {
          left: rect.left - pad,
          top: rect.top - pad,
          width: rect.width + 2 * pad,
          height: rect.height + 2 * pad,
        }
      : null;
    const box = bubbleEl.getBoundingClientRect();
    bubblePos = placeBubble(
      targetRect,
      { width: box.width, height: box.height },
      { width: window.innerWidth, height: window.innerHeight },
      current.placement,
      0.75 * rem(),
      rem()
    );
  }

  // A new step: bring a target that is off screen into view, then measure.
  $effect(() => {
    const current = view;
    const bubble = bubbleEl;
    if (!current || !bubble || !visible) return;
    untrack(() => {
      // A new step glides from the last one, whatever the scroll left set.
      tracking = false;
      const element = current.anchorId ? resolveGuideAnchor(current.anchorId)?.element : null;
      if (element) {
        const r = element.getBoundingClientRect();
        if (
          r.bottom < 0 ||
          r.top > window.innerHeight ||
          r.right < 0 ||
          r.left > window.innerWidth
        ) {
          element.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
        }
      }
      measure();
    });
  });

  // Anything that can move the target or the bubble re-measures - events, never a poll - and at
  // most ONCE PER FRAME: a scroll fires many events a frame, and each measure forces a layout.
  $effect(() => {
    if (!visible || !bubbleEl) return;
    const current = view;
    const element = current?.anchorId ? resolveGuideAnchor(current.anchorId)?.element : null;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const onScroll = () => {
      tracking = true;
      schedule();
    };
    const onScrollEnd = () => (tracking = false);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('scrollend', onScrollEnd, { capture: true, passive: true });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(bubbleEl);
    if (element) observer?.observe(element);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('scrollend', onScrollEnd, { capture: true });
      observer?.disconnect();
    };
  });

  // ---- Focus and announcement. ------------------------------------------------------------------
  let announcement = $state('');

  $effect(() => {
    const current = view;
    const bubble = bubbleEl;
    if (!current || !bubble || !visible) return;
    untrack(() => {
      announcement = m.guide_step_announce({
        position: current.position,
        total: current.total,
        title: current.title(),
      });
      bubble.focus({ preventScroll: true });
    });
  });

  /**
   * `focusTrap` while the step is modal, and only then: a hint leaves the page usable, so Tab must be
   * able to leave its bubble. Focus still moves INTO the bubble on every step, modal or not.
   */
  function trapWhenModal(node: HTMLElement, modal: boolean) {
    let trap: { destroy(): void } | null = modal ? focusTrap(node) : null;
    return {
      update(next: boolean) {
        if (next && !trap) trap = focusTrap(node);
        else if (!next && trap) {
          trap.destroy();
          trap = null;
        }
      },
      destroy() {
        trap?.destroy();
      },
    };
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      guideEngine.end('escape');
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      guideEngine.next();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      guideEngine.previous();
    }
  }

  const last = $derived(view !== null && view.position === view.total);
</script>

<!-- Always mounted, so a change of its text is announced: a live region created WITH its text is not. -->
<div class="sr-only" aria-live="polite" aria-atomic="true" data-guide-live>{announcement}</div>

{#if visible && view}
  {@const Icon = view.step.icon}
  <div
    use:portal
    class="fixed inset-0 z-(--z-guide) {view.modal ? '' : 'pointer-events-none'}"
    data-guide-overlay={view.guide.id}
    data-guide-step={view.step.id}
    data-motion={reducedMotion ? 'reduced' : 'full'}
  >
    {#if view.modal}
      <!-- Takes every pointer: the page behind a tour cannot be used. A tap here does nothing - the
           bubble's buttons and Esc/Back are the ways out, so a stray tap cannot lose the tour. -->
      <div class="absolute inset-0" data-guide-blocker aria-hidden="true"></div>
    {/if}

    {#if targetRect}
      <div
        class="guide-spotlight"
        data-dim={view.modal || undefined}
        style="transform: translate({targetRect.left}px, {targetRect.top}px); width: {targetRect.width}px; height: {targetRect.height}px;"
        data-tracking={tracking || undefined}
        data-guide-spotlight
        aria-hidden="true"
      >
        <span class="guide-spotlight-ring" data-pulse={!reducedMotion || undefined}></span>
      </div>
    {:else if view.modal}
      <div class="bg-cn-scrim/55 absolute inset-0" aria-hidden="true"></div>
    {/if}

    <div
      bind:this={bubbleEl}
      use:trapWhenModal={view.modal}
      role="dialog"
      aria-modal={view.modal}
      aria-labelledby="guide-bubble-title"
      aria-describedby="guide-bubble-body"
      tabindex="-1"
      onkeydown={onKeydown}
      class="guide-bubble bg-cn-popover border-cn-border pointer-events-auto absolute w-[min(20rem,calc(100vw-2rem))] rounded-2xl border p-4 shadow-xl outline-none"
      style="transform: translate({bubblePos?.left ?? 0}px, {bubblePos?.top ??
        0}px); visibility: {bubblePos ? 'visible' : 'hidden'};"
      data-tracking={tracking || undefined}
      data-guide-bubble
      data-side={bubblePos?.side}
    >
      {#key view.step.id}
        <div class="motion-pop-in">
          <div class="mb-2 flex items-center gap-2">
            {#if Icon}
              <span
                class="bg-cn-yellow/15 text-guide-ink flex size-8 shrink-0 items-center justify-center rounded-lg"
                aria-hidden="true"
              >
                <Icon size={18} />
              </span>
            {/if}
            <h2 id="guide-bubble-title" class="text-text-main min-w-0 flex-1 text-base font-bold">
              {view.title()}
            </h2>
            {#if view.total > 1}
              <span
                class="text-text-muted shrink-0 text-xs font-semibold tabular-nums"
                data-guide-counter
              >
                {m.guide_step_counter({ position: view.position, total: view.total })}
              </span>
            {/if}
          </div>
          <p id="guide-bubble-body" class="text-text-muted text-sm leading-relaxed">
            {view.body()}
          </p>
          {#if view.step.gesture === 'swipe-right'}
            <div
              class="text-guide-ink mt-3 flex items-center justify-center"
              data-guide-gesture="swipe-right"
              aria-hidden="true"
            >
              <span class="guide-swipe-mime" data-play={!reducedMotion || undefined}>
                <ChevronsRight size={28} />
              </span>
            </div>
          {/if}
        </div>
      {/key}

      <div class="mt-4 flex items-center gap-2">
        <button
          type="button"
          class="text-text-muted hover:text-text-main hover:bg-text-main/10 rounded-lg px-3 py-2 text-sm font-semibold transition-colors"
          onclick={() => guideEngine.end('skipped')}
          data-guide-skip
        >
          {m.guide_skip()}
        </button>
        <span class="flex-1"></span>
        {#if view.position > 1}
          <button
            type="button"
            class="border-cn-border text-text-main hover:bg-text-main/10 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors"
            onclick={() => guideEngine.previous()}
            data-guide-previous
          >
            {m.guide_previous()}
          </button>
        {/if}
        <button
          type="button"
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-lg px-4 py-2 text-sm font-bold transition-colors"
          onclick={() => guideEngine.next()}
          data-guide-next
        >
          {last ? m.guide_done() : m.guide_next()}
        </button>
      </div>
    </div>
  </div>
{/if}
