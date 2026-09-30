<script lang="ts">
  /**
   * Full-screen viewer for one image or video: zoom and pan, swipes between items, swipe down to
   * close, swipe up (or the info button) for the information panel.
   *
   * THE FRAME AND THE GESTURES ARE MIGALLERY'S (2026-09-27), which copied Google Photos on the Mi 9T:
   * black edge to edge at every width, the bars floating over the picture and hidden by a single
   * tap, the date and time as the title, a horizontal swipe that follows the finger, a downward
   * drag that shrinks the picture and fades the ground. The decisions (which gesture a touch is,
   * whether a released swipe commits) are pure and tested in `utils/viewerGestures.ts`; the zoom
   * stays in `utils/pinchZoom.ts`, the module the PDF reader shares, because a bitmap zoom and a
   * paged column need two models (see there).
   *
   * THE INFORMATION PANEL SHOWS WHAT THE CLIENT KNOWS. Canari's media is end-to-end encrypted and
   * compressed before it is sent, so there is no EXIF to read and no server that could: the panel
   * names the sender, the date, the file, its size and its pixel dimensions - the last MEASURED on
   * the element on screen, which is the truth about what is shown whatever the sender declared.
   *
   * Everything that is not the content (portal, backdrop, bars, Back) is {@link FullScreenViewer},
   * in its `immersive` frame.
   */
  import type { Snippet } from 'svelte';
  import {
    CalendarDays,
    ChevronLeft,
    ChevronRight,
    Download,
    Image as ImageIcon,
    Info,
    UserRound,
    X,
  } from '@lucide/svelte';
  import { fade, fly } from 'svelte/transition';
  import { clampTranslation, zoomAboutPivot } from '$lib/utils/pinchZoom';
  import {
    GESTURE,
    classifyMove,
    decideDismiss,
    decideSwipe,
    dismissProgress,
    dismissScale,
    dragOffset,
    isDoubleTap,
    isTap,
    releaseVelocity,
    type GestureKind,
    type Sample,
  } from '$lib/utils/viewerGestures';
  import {
    dimensionsParts,
    formatViewerDateTitle,
    formatViewerFullDate,
    type MediaViewerInfo,
  } from '$lib/utils/mediaViewerInfo';
  import { formatFileSize } from '$lib/utils/fileSize';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import FullScreenViewer from './FullScreenViewer.svelte';
  import UserName from './UserName.svelte';
  import EmojiText from './EmojiText.svelte';

  interface Props {
    open?: boolean;
    onClose: () => void;
    ariaLabel?: string;
    /** Shown as the title when `info` carries no date (a photo still in the composer). */
    title?: string;
    /** What the call site knows about the media: title and information panel. */
    info?: MediaViewerInfo;
    onDownload?: () => void;
    showPrev?: boolean;
    showNext?: boolean;
    onPrev?: () => void;
    onNext?: () => void;
    dotCount?: number;
    dotIndex?: number;
    onDotSelect?: (index: number) => void;
    children?: Snippet;
  }

  let {
    open = false,
    onClose,
    ariaLabel = m.media_lightbox_default_aria(),
    title = '',
    info,
    onDownload,
    showPrev = false,
    showNext = false,
    onPrev,
    onNext,
    dotCount = 0,
    dotIndex = 0,
    onDotSelect,
    children,
  }: Props = $props();

  // ---- Back-button support ----
  // Opening the lightbox pushes a browser history entry, same mechanism Modal.svelte and the
  // PIN modal already use: physical/hardware Back then closes the lightbox instead of leaving
  // the app or navigating the underlying conversation away.
  const historyOverlay = bindHistoryOverlay(
    () => open,
    () => onClose()
  );
  $effect(() => {
    historyOverlay.syncOpen();
  });
  /** Every UI-triggered close (Back, Escape, swipe) goes through here, never straight to
   * `onClose`, so it stays in sync with the history entry pushed above. */
  function dismiss() {
    historyOverlay.dismissFromUi();
  }

  const canPrev = $derived(showPrev && !!onPrev);
  const canNext = $derived(showNext && !!onNext);

  // ---- Zoom / pan ----
  const MIN_SCALE = 1;
  const MAX_SCALE = 8;

  let scale = $state(1);
  let tx = $state(0);
  let ty = $state(0);
  let isDragging = $state(false);
  let showZoomIndicator = $state(false);
  let zoomTimeout: ReturnType<typeof setTimeout> | null = null;

  // ---- The frame ----
  /** The bars are faded out: a single tap toggles them (the immersive black view). */
  let chromeHidden = $state(false);
  let infoOpen = $state(false);

  // ---- Swipes: where the picture sits while a finger drags it, and the snap after ----
  let swipeDx = $state(0);
  let dismissDy = $state(0);
  /** A snap is animating; the transform transitions only while this is set. */
  let settling = $state(false);
  /** What to do once the running snap has landed (show the neighbour), or nothing. */
  let afterSettle: (() => void) | null = null;
  /** The frame's height, read when a touch starts: the dismiss progress is a fraction of it. */
  let frameHeight = $state(1);

  // Non-reactive touch tracking: one sequence from the first finger down to the last one up.
  let gesture: GestureKind | null = null;
  let touchStart: Sample = { x: 0, y: 0, t: 0 };
  let samples: Sample[] = [];
  let dragStartTx = 0,
    dragStartTy = 0,
    dragStartX = 0,
    dragStartY = 0;
  let lastPinchDist = 0;
  let lastTap: Sample | null = null;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;

  let transformEl = $state<HTMLDivElement | null>(null);

  const isZoomed = $derived(scale > 1.005);
  const scaleLabel = $derived(`${Math.round(scale * 100)}%`);
  const progress = $derived(dismissProgress(dismissDy, frameHeight));

  // ---- What the viewer says about the media ----
  /** Pixel size read off the element on screen once it has loaded. */
  let measured = $state<{ width: number; height: number } | null>(null);
  const locale = $derived(getLocale());
  const dateTitle = $derived(
    formatViewerDateTitle(info?.sentAt, {
      locale,
      labels: { today: m.media_viewer_today(), yesterday: m.media_viewer_yesterday() },
    })
  );
  const fullDate = $derived(formatViewerFullDate(info?.sentAt, locale));
  const dimensions = $derived(
    dimensionsParts(measured?.width ?? info?.width, measured?.height ?? info?.height, locale)
  );
  const sizeText = $derived(info?.sizeBytes ? formatFileSize(info.sizeBytes) : null);
  const fileName = $derived(info?.fileName ?? title);
  const hasSender = $derived(!!(info?.senderId || info?.senderName));

  function reducedMotion(): boolean {
    return (
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  function resetZoom() {
    if (zoomTimeout) {
      clearTimeout(zoomTimeout);
      zoomTimeout = null;
    }
    scale = 1;
    tx = 0;
    ty = 0;
    isDragging = false;
    showZoomIndicator = false;
  }

  /** Drops every in-flight gesture and puts the picture back where it rests. */
  function resetGesture() {
    gesture = null;
    samples = [];
    swipeDx = 0;
    dismissDy = 0;
    settling = false;
    afterSettle = null;
    if (tapTimer) {
      clearTimeout(tapTimer);
      tapTimer = null;
    }
    lastTap = null;
  }

  function showIndicator() {
    showZoomIndicator = true;
    if (zoomTimeout) clearTimeout(zoomTimeout);
    zoomTimeout = setTimeout(() => (showZoomIndicator = false), 1400);
  }

  /**
   * The live geometry the translation must stay inside, or `undefined` while nothing is laid out.
   *
   * Measured here and passed to the pure clamp rather than measured inside it: the DOM read is the
   * one part that cannot be tested without a browser, so it is kept as small as possible.
   */
  function panBounds() {
    const parent = transformEl?.parentElement;
    if (!transformEl || !parent) return undefined;
    return {
      contentWidth: transformEl.offsetWidth,
      contentHeight: transformEl.offsetHeight,
      viewportWidth: parent.clientWidth,
      viewportHeight: parent.clientHeight,
    };
  }

  /** Applies a drag delta, clamped to the content's own edges. */
  function panTo(nextTx: number, nextTy: number) {
    const bounds = panBounds();
    if (!bounds) {
      tx = nextTx;
      ty = nextTy;
      return;
    }
    [tx, ty] = clampTranslation(nextTx, nextTy, { ...bounds, scale });
  }

  /** Zoom around a pivot point expressed in element-center coordinates. */
  function zoomAt(newScale: number, pivotX: number, pivotY: number) {
    const next = zoomAboutPivot({
      scale,
      tx,
      ty,
      nextScale: newScale,
      pivotX,
      pivotY,
      minScale: MIN_SCALE,
      maxScale: MAX_SCALE,
      bounds: panBounds(),
    });
    scale = next.scale;
    tx = next.tx;
    ty = next.ty;
    showIndicator();
  }

  /** Pivot for a pointer event, in the transform wrapper's centre-relative coordinates. */
  function pivotOf(e: { clientX: number; clientY: number }, el: HTMLElement) {
    const rect = el.getBoundingClientRect();
    return {
      x: e.clientX - rect.left - rect.width / 2,
      y: e.clientY - rect.top - rect.height / 2,
    };
  }

  /** The double-tap / double-click toggle: 2.5x on the pointed spot, or back to 1x. */
  function toggleZoomAt(point: { clientX: number; clientY: number }) {
    if (!transformEl) return;
    if (isZoomed) {
      resetZoom();
      return;
    }
    const pivot = pivotOf(point, transformEl);
    zoomAt(GESTURE.DOUBLE_TAP_SCALE, pivot.x, pivot.y);
  }

  /**
   * Moves the picture to `to` with the snap transition, then runs `then` once it has landed.
   *
   * The landing is the transform's own `transitionend`, never a timer - and a snap that would not
   * move anything (or a reader who asked for reduced motion) runs `then` at once, because a
   * transition that does not happen fires no end event and would leave the viewer waiting for ever.
   */
  function settle(to: { swipeDx?: number; dismissDy?: number }, then?: () => void) {
    const nextDx = to.swipeDx ?? swipeDx;
    const nextDy = to.dismissDy ?? dismissDy;
    if (reducedMotion() || (nextDx === swipeDx && nextDy === dismissDy)) {
      swipeDx = nextDx;
      dismissDy = nextDy;
      settling = false;
      afterSettle = null;
      then?.();
      return;
    }
    settling = true;
    afterSettle = then ?? null;
    swipeDx = nextDx;
    dismissDy = nextDy;
  }

  function handleTransitionEnd(e: TransitionEvent) {
    if (e.target !== transformEl || e.propertyName !== 'transform') return;
    settling = false;
    const next = afterSettle;
    afterSettle = null;
    next?.();
  }

  /** A released swipe that commits: the picture leaves on the side it was thrown, then the neighbour shows. */
  function commitSwipe(direction: 'next' | 'previous') {
    Log.d('mediaLightbox.swipe', { direction });
    const width = transformEl?.parentElement?.clientWidth ?? window.innerWidth;
    settle({ swipeDx: direction === 'next' ? -width : width }, () => {
      swipeDx = 0;
      if (direction === 'next') handleNext();
      else handlePrev();
    });
  }

  /** A single tap, confirmed once the double-tap window has passed without a second one. */
  function handleTap(tap: Sample) {
    if (isDoubleTap(lastTap, tap)) {
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = null;
      lastTap = null;
      toggleZoomAt({ clientX: tap.x, clientY: tap.y });
      return;
    }
    lastTap = tap;
    if (tapTimer) clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      tapTimer = null;
      lastTap = null;
      chromeHidden = !chromeHidden;
      Log.d('mediaLightbox.chrome', { hidden: chromeHidden });
    }, GESTURE.DOUBLE_TAP_MS);
  }

  function openInfo() {
    Log.d('mediaLightbox.info', { open: true });
    infoOpen = true;
    chromeHidden = false;
  }

  function closeInfo() {
    Log.d('mediaLightbox.info', { open: false });
    infoOpen = false;
  }

  // Wheel zoom handler (registered non-passively via $effect)
  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const pivot = pivotOf(e, e.currentTarget as HTMLElement);
    const delta = e.deltaY * (e.deltaMode === 1 ? 20 : 1);
    zoomAt(scale * Math.pow(0.999, delta), pivot.x, pivot.y);
  }

  // Touch listeners are attached by hand with `passive: false`: Svelte registers `ontouchstart` /
  // `ontouchmove` as passive, where `preventDefault()` is ignored.
  $effect(() => {
    const el = transformEl;
    if (!el || !open) return;

    el.addEventListener('wheel', handleWheel, { passive: false });

    const sampleOf = (t: Touch, time: number): Sample => ({ x: t.clientX, y: t.clientY, t: time });

    function onTouchStart(e: TouchEvent) {
      // A video's taps and drags belong to its native controls, a button's to the button.
      if ((e.target as HTMLElement).closest('video, button')) {
        gesture = null;
        return;
      }
      if (e.touches.length >= 2) {
        // A second finger turns anything into a pinch; a swipe under way springs back.
        if (gesture === 'swipe-h' || gesture === 'swipe-down') settle({ swipeDx: 0, dismissDy: 0 });
        gesture = 'pinch';
        lastPinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        e.preventDefault();
        return;
      }
      if (settling) return;
      gesture = 'pending';
      touchStart = sampleOf(e.touches[0], e.timeStamp);
      samples = [touchStart];
      dragStartTx = tx;
      dragStartTy = ty;
      frameHeight = el!.parentElement?.clientHeight || window.innerHeight;
    }

    function onTouchMove(e: TouchEvent) {
      if (gesture === 'pinch') {
        if (e.touches.length < 2) return;
        e.preventDefault();
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const pivot = pivotOf(
          {
            clientX: (e.touches[0].clientX + e.touches[1].clientX) / 2,
            clientY: (e.touches[0].clientY + e.touches[1].clientY) / 2,
          },
          el!
        );
        zoomAt(scale * (dist / lastPinchDist), pivot.x, pivot.y);
        lastPinchDist = dist;
        return;
      }
      if (!gesture || e.touches.length !== 1) return;

      const now = sampleOf(e.touches[0], e.timeStamp);
      samples.push(now);
      if (samples.length > 12) samples.shift();
      const dx = now.x - touchStart.x;
      const dy = now.y - touchStart.y;

      if (gesture === 'pending') {
        // Classified ONCE, then kept until every finger lifts: a swipe that curves stays a swipe.
        gesture = classifyMove({ dx, dy, zoomed: isZoomed, touches: 1 });
        if (gesture === 'pending') return;
      }
      e.preventDefault();

      if (gesture === 'pan') panTo(dragStartTx + dx, dragStartTy + dy);
      else if (gesture === 'swipe-h') swipeDx = dragOffset(dx, canPrev, canNext);
      else if (gesture === 'swipe-down') dismissDy = Math.max(0, dy);
    }

    function onTouchEnd(e: TouchEvent) {
      if (gesture === 'pinch') {
        // The last fingers of a pinch lifting one by one are not a new gesture.
        if (e.touches.length === 0) gesture = null;
        return;
      }
      if (e.touches.length > 0 || !gesture) return;

      const end = sampleOf(e.changedTouches[0], e.timeStamp);
      samples.push(end);
      const kind = gesture;
      gesture = null;
      const dx = end.x - touchStart.x;
      const dy = end.y - touchStart.y;

      if (kind === 'pending') {
        if (isTap(touchStart, end)) {
          // Cancelled so the tap does not also become the browser's click / dblclick.
          e.preventDefault();
          handleTap(end);
        }
        return;
      }

      const velocity = releaseVelocity(samples);
      if (kind === 'swipe-h') {
        const width = el!.parentElement?.clientWidth ?? window.innerWidth;
        const decision = decideSwipe({
          dx,
          velocityX: velocity.x,
          width,
          hasPrevious: canPrev,
          hasNext: canNext,
        });
        if (decision === 'stay') settle({ swipeDx: 0 });
        else commitSwipe(decision);
      } else if (kind === 'swipe-down') {
        const closes = decideDismiss({ dy, velocityY: velocity.y, height: frameHeight });
        if (closes && infoOpen) {
          // Down closes the sheet first, as Escape does: the viewer is what is under it.
          closeInfo();
          settle({ dismissDy: 0 });
        } else if (closes) {
          Log.d('mediaLightbox.swipe', { direction: 'dismiss' });
          dismiss();
        } else {
          settle({ dismissDy: 0 });
        }
      } else if (kind === 'swipe-up') {
        if (-dy >= GESTURE.FLICK_MIN_DISTANCE_PX) openInfo();
      }
    }

    function onTouchCancel() {
      gesture = null;
      settle({ swipeDx: 0, dismissDy: 0 });
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    el.addEventListener('touchcancel', onTouchCancel);

    return () => {
      el.removeEventListener('wheel', handleWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
    };
  });

  /**
   * Reads the pixel size of the image or video once it has loaded - the dimensions line of the
   * information panel. `load` and `loadedmetadata` do not bubble, so they are caught in the
   * capture phase; a picture already decoded from the cache before this ran is read at once.
   */
  $effect(() => {
    const el = transformEl;
    if (!el || !open) return;

    function read(target: EventTarget | null) {
      if (target instanceof HTMLImageElement && target.naturalWidth > 0) {
        measured = { width: target.naturalWidth, height: target.naturalHeight };
      } else if (target instanceof HTMLVideoElement && target.videoWidth > 0) {
        measured = { width: target.videoWidth, height: target.videoHeight };
      }
    }
    const onLoad = (e: Event) => read(e.target);
    el.addEventListener('load', onLoad, true);
    el.addEventListener('loadedmetadata', onLoad, true);
    const shown = el.querySelector('img, video');
    if (shown instanceof HTMLImageElement && shown.complete) read(shown);
    else if (shown instanceof HTMLVideoElement && shown.readyState >= 1) read(shown);

    return () => {
      el.removeEventListener('load', onLoad, true);
      el.removeEventListener('loadedmetadata', onLoad, true);
    };
  });

  /**
   * Refuses the browser's own image drag, which is what made panning impossible with a mouse.
   *
   * An `<img>` is `draggable` by DEFAULT. A press and a move over one starts a drag-and-drop of the
   * picture - the translucent ghost a reader reads as "it selected the image" (user, 2026-09-22:
   * *"on ne puisse pas se deplacer dans la visionneuse, le fait de tenter de drag l'image la
   * selectionne"*) - and the browser then stops sending pointer moves, so `handlePointerMove` never
   * runs and the pan never happens.
   *
   * `select-none` on this wrapper does NOT cover it: measured in a live engine, the image computes
   * `user-select: none` and `dragstart` still fires uncancelled. The two are different gestures.
   *
   * IT IS ON THE WRAPPER, NOT ON THE IMAGE, because the content is `{@render children}` - every
   * call site passes its own markup, and a rule each of them has to remember is a rule one of them
   * will not. The wrapper already owns the zoom and the pan; it owns their competitor too.
   */
  function refuseNativeDrag(e: DragEvent) {
    e.preventDefault();
  }

  // Mouse drag (pointer events, declarative handlers)
  function handlePointerDown(e: PointerEvent) {
    if (e.pointerType === 'touch' || !isZoomed) return;
    const target = e.target as HTMLElement;
    if (target.closest('video, button')) return;
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartTx = tx;
    dragStartTy = ty;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    if (!isDragging || e.pointerType === 'touch') return;
    panTo(dragStartTx + e.clientX - dragStartX, dragStartTy + e.clientY - dragStartY);
  }

  function handlePointerUp(e: PointerEvent) {
    if (e.pointerType === 'touch') return;
    isDragging = false;
  }

  // Double-click: toggle between 1x and 2.5x
  function handleDoubleClick(e: MouseEvent) {
    e.stopPropagation();
    const target = e.target as HTMLElement;
    if (target.closest('video, button')) return;
    toggleZoomAt(e);
  }

  function handleArrowKeys(e: KeyboardEvent) {
    if (isZoomed || e.defaultPrevented) return;
    if (e.key === 'ArrowLeft' && canPrev) {
      e.preventDefault();
      handlePrev();
    }
    if (e.key === 'ArrowRight' && canNext) {
      e.preventDefault();
      handleNext();
    }
  }

  /** Escape peels one layer at a time: the panel, then the zoom, then the viewer. */
  function handleEscape() {
    if (infoOpen) closeInfo();
    else if (isZoomed) resetZoom();
    else dismiss();
  }

  function handlePrev() {
    resetZoom();
    resetGesture();
    measured = null;
    onPrev?.();
  }
  function handleNext() {
    resetZoom();
    resetGesture();
    measured = null;
    onNext?.();
  }

  $effect(() => {
    if (open) return;
    resetZoom();
    resetGesture();
    measured = null;
    infoOpen = false;
    chromeHidden = false;
  });
</script>

<svelte:window onkeydown={open ? handleArrowKeys : undefined} />

{#if open}
  <FullScreenViewer
    {ariaLabel}
    onClose={dismiss}
    onEscape={handleEscape}
    lockTouch
    immersive
    chromeHidden={chromeHidden || progress > 0}
    backdropOpacity={1 - progress}
  >
    {#snippet headerLead()}
      <!-- Google Photos' title: the day on the first line, the time under it; the name otherwise. -->
      {#if dateTitle}
        <button
          type="button"
          class="min-w-0 flex-1 text-left leading-tight"
          onclick={(e) => {
            e.stopPropagation();
            openInfo();
          }}
        >
          <span class="block truncate text-base font-semibold">{dateTitle.date}</span>
          <span class="block truncate text-xs text-white/75">{dateTitle.time}</span>
        </button>
      {:else}
        <p class="min-w-0 flex-1 truncate text-sm text-white/85">{title}</p>
      {/if}
    {/snippet}

    {#snippet headerActions()}
      {#if onDownload}
        <button
          type="button"
          class="ui-icon-button rounded-full transition-colors hover:bg-white/15"
          onclick={(e) => {
            e.stopPropagation();
            onDownload!();
          }}
          aria-label={m.common_download_label()}
          title={m.common_download_label()}
        >
          <Download size={22} strokeWidth={2.25} />
        </button>
      {/if}
      <button
        type="button"
        class="ui-icon-button rounded-full transition-colors hover:bg-white/15 {infoOpen
          ? 'bg-white/15'
          : ''}"
        onclick={(e) => {
          e.stopPropagation();
          if (infoOpen) closeInfo();
          else openInfo();
        }}
        aria-label={m.media_viewer_info()}
        aria-expanded={infoOpen}
        title={m.media_viewer_info()}
      >
        <Info size={22} strokeWidth={2.25} />
      </button>
    {/snippet}

    <div class="relative flex min-h-0 w-full flex-1">
      <div
        class="pointer-events-none relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden"
      >
        {#if canPrev}
          <!-- Pointer devices only: a touch screen swipes. -->
          <button
            type="button"
            class="ui-icon-button pointer-events-auto absolute left-3 z-20 rounded-full bg-black/40 transition-[opacity,background-color] duration-200 hover:bg-black/60 pointer-coarse:hidden {chromeHidden
              ? 'opacity-0'
              : ''}"
            onclick={(e) => {
              e.stopPropagation();
              handlePrev();
            }}
            aria-label={m.media_lightbox_prev_aria()}
          >
            <ChevronLeft size={26} strokeWidth={2.5} />
          </button>
        {/if}

        <!-- Transform wrapper: zoom + pan + swipe target -->
        <div
          bind:this={transformEl}
          role="presentation"
          class="pointer-events-auto relative z-10 flex h-full w-full items-center justify-center select-none"
          style="transform: translate({tx + swipeDx}px, {ty + dismissDy}px) scale({scale *
            dismissScale(
              progress
            )}); transform-origin: center; will-change: transform; touch-action: none; transition: {settling
            ? `transform ${GESTURE.SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`
            : 'none'}; cursor: {isDragging ? 'grabbing' : isZoomed ? 'grab' : 'zoom-in'};"
          onclick={(e) => e.stopPropagation()}
          ondblclick={handleDoubleClick}
          ondragstart={refuseNativeDrag}
          onpointerdown={handlePointerDown}
          onpointermove={handlePointerMove}
          onpointerup={handlePointerUp}
          onpointercancel={handlePointerUp}
          ontransitionend={handleTransitionEnd}
        >
          {@render children?.()}
        </div>

        {#if canNext}
          <button
            type="button"
            class="ui-icon-button pointer-events-auto absolute right-3 z-20 rounded-full bg-black/40 transition-[opacity,background-color] duration-200 hover:bg-black/60 pointer-coarse:hidden {chromeHidden
              ? 'opacity-0'
              : ''}"
            onclick={(e) => {
              e.stopPropagation();
              handleNext();
            }}
            aria-label={m.media_lightbox_next_aria()}
          >
            <ChevronRight size={26} strokeWidth={2.5} />
          </button>
        {/if}

        <!-- Zoom level indicator -->
        {#if showZoomIndicator}
          <div
            transition:fade={{ duration: 200 }}
            class="pointer-events-none absolute bottom-16 left-1/2 z-30 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs font-semibold text-white/90 tabular-nums"
          >
            {scaleLabel}
          </div>
        {/if}
      </div>

      {#if infoOpen}
        <!--
          A bottom sheet on a phone, a right-hand column from `md` up (Google Photos). The column is
          a flex sibling, so the picture narrows beside it instead of hiding under it; `z-30` puts it
          over the floating bar, whose right half it covers - it carries its own close.
        -->
        <aside
          aria-label={m.media_viewer_info()}
          class="absolute inset-x-0 bottom-0 z-30 max-h-[60%] overflow-y-auto rounded-t-2xl bg-neutral-900 text-white md:relative md:inset-auto md:max-h-none md:w-80 md:shrink-0 md:rounded-none md:border-l md:border-white/10"
          style="padding-bottom: max(1rem, env(safe-area-inset-bottom, 1rem));"
          transition:fly={{ y: 32, duration: 200 }}
          onclick={(e) => e.stopPropagation()}
          role="presentation"
        >
          <div
            class="flex items-center justify-between px-4 pt-3 pb-1 md:pt-[max(0.75rem,var(--safe-area-inset-top,0.75rem))]"
          >
            <h2 class="text-lg font-semibold">{m.media_viewer_info()}</h2>
            <button
              type="button"
              class="ui-icon-button rounded-full transition-colors hover:bg-white/15"
              onclick={closeInfo}
              aria-label={m.common_close_label()}
              title={m.common_close_label()}
            >
              <X size={22} strokeWidth={2.25} />
            </button>
          </div>

          <dl class="flex flex-col">
            {#if fullDate}
              <div class="flex items-start gap-4 px-4 py-3">
                <dt class="shrink-0 pt-0.5 text-white/70">
                  <CalendarDays size={22} strokeWidth={1.75} aria-hidden="true" />
                </dt>
                <dd class="min-w-0 text-sm">{fullDate}</dd>
              </div>
            {/if}
            {#if hasSender}
              <div class="flex items-start gap-4 px-4 py-3">
                <dt class="shrink-0 pt-0.5 text-white/70">
                  <UserRound size={22} strokeWidth={1.75} aria-hidden="true" />
                </dt>
                <dd class="min-w-0 text-sm">
                  {#if info?.senderId}
                    <UserName userId={info.senderId} link={false} />
                  {:else if info?.senderName}
                    <EmojiText text={info.senderName} />
                  {/if}
                </dd>
              </div>
            {/if}
            {#if fileName || sizeText || dimensions}
              <div class="flex items-start gap-4 px-4 py-3">
                <dt class="shrink-0 pt-0.5 text-white/70">
                  <ImageIcon size={22} strokeWidth={1.75} aria-hidden="true" />
                </dt>
                <dd class="min-w-0 text-sm">
                  {#if fileName}
                    <span class="block break-all">{fileName}</span>
                  {/if}
                  {#if sizeText || dimensions}
                    <span class="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-white/65">
                      {#if sizeText}<span>{sizeText}</span>{/if}
                      {#if sizeText && dimensions}<span aria-hidden="true">&middot;</span>{/if}
                      {#if dimensions}<span>{m.media_viewer_dimensions(dimensions)}</span>{/if}
                    </span>
                  {/if}
                </dd>
              </div>
            {/if}
          </dl>
        </aside>
      {/if}
    </div>

    {#snippet footer()}
      {#if dotCount > 1 && onDotSelect}
        <div class="pointer-events-auto flex justify-center gap-1.5 pt-2">
          {#each { length: dotCount } as _, i (i)}
            <button
              type="button"
              onclick={(e) => {
                e.stopPropagation();
                resetZoom();
                measured = null;
                onDotSelect!(i);
              }}
              class="h-2 w-2 rounded-full transition-all {i === dotIndex
                ? 'bg-white'
                : 'bg-white/35'}"
              aria-label={m.media_lightbox_dot_aria({ index: i + 1 })}
            ></button>
          {/each}
        </div>
      {/if}
    {/snippet}
  </FullScreenViewer>
{/if}
