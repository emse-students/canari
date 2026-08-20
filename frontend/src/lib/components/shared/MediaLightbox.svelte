<script lang="ts">
  /**
   * Full-screen viewer for one image or video, with pinch/wheel zoom and drag panning.
   *
   * The content is a single bitmap, so the whole zoom is one CSS transform on one wrapper and the
   * arithmetic that keeps the pinched point still lives in `utils/pinchZoom.ts` beside the PDF
   * reader's - see there for why the two viewers need two different models and share one module.
   * Everything that is not the gesture (portal, backdrop, card, header, close) is
   * {@link FullScreenViewer}.
   */
  import type { Snippet } from 'svelte';
  import { ChevronLeft, ChevronRight } from '@lucide/svelte';
  import { fade } from 'svelte/transition';
  import { clampTranslation, zoomAboutPivot } from '$lib/utils/pinchZoom';
  import { m } from '$lib/paraglide/messages';
  import FullScreenViewer from './FullScreenViewer.svelte';

  interface Props {
    open?: boolean;
    onClose: () => void;
    ariaLabel?: string;
    title?: string;
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

  // ---- Zoom / pan ----
  const MIN_SCALE = 1;
  const MAX_SCALE = 8;

  let scale = $state(1);
  let tx = $state(0);
  let ty = $state(0);
  let isDragging = $state(false);
  let showZoomIndicator = $state(false);

  // Non-reactive drag/pinch tracking
  let dragStartX = 0,
    dragStartY = 0,
    dragStartTx = 0,
    dragStartTy = 0;
  let isPinching = false,
    lastPinchDist = 0;
  let zoomTimeout: ReturnType<typeof setTimeout> | null = null;

  let transformEl = $state<HTMLDivElement | null>(null);

  const isZoomed = $derived(scale > 1.005);
  const scaleLabel = $derived(`${Math.round(scale * 100)}%`);

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

  // Wheel zoom handler (registered non-passively via $effect)
  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const pivot = pivotOf(e, e.currentTarget as HTMLElement);
    const delta = e.deltaY * (e.deltaMode === 1 ? 20 : 1);
    zoomAt(scale * Math.pow(0.999, delta), pivot.x, pivot.y);
  }

  // Attach non-passive wheel + touch listeners
  $effect(() => {
    const el = transformEl;
    if (!el || !open) return;

    el.addEventListener('wheel', handleWheel, { passive: false });

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
        isPinching = true;
        lastPinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        e.preventDefault();
      } else if (e.touches.length === 1 && isZoomed) {
        const target = e.target as HTMLElement;
        if (target.closest('video, button')) return;
        isDragging = true;
        dragStartX = e.touches[0].clientX;
        dragStartY = e.touches[0].clientY;
        dragStartTx = tx;
        dragStartTy = ty;
        e.preventDefault();
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (isPinching && e.touches.length === 2) {
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
      } else if (isDragging && e.touches.length === 1) {
        e.preventDefault();
        panTo(
          dragStartTx + e.touches[0].clientX - dragStartX,
          dragStartTy + e.touches[0].clientY - dragStartY
        );
      }
    }

    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length < 2) isPinching = false;
      if (e.touches.length === 0) isDragging = false;
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);

    return () => {
      el.removeEventListener('wheel', handleWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  });

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
    if (isZoomed) {
      resetZoom();
    } else {
      const pivot = pivotOf(e, e.currentTarget as HTMLElement);
      zoomAt(2.5, pivot.x, pivot.y);
    }
  }

  function handleArrowKeys(e: KeyboardEvent) {
    if (isZoomed) return;
    if (e.key === 'ArrowLeft' && showPrev && onPrev) {
      e.preventDefault();
      handlePrev();
    }
    if (e.key === 'ArrowRight' && showNext && onNext) {
      e.preventDefault();
      handleNext();
    }
  }

  function handlePrev() {
    resetZoom();
    onPrev?.();
  }
  function handleNext() {
    resetZoom();
    onNext?.();
  }

  $effect(() => {
    if (!open) resetZoom();
  });
</script>

<svelte:window onkeydown={open ? handleArrowKeys : undefined} />

{#if open}
  <FullScreenViewer
    {ariaLabel}
    {onClose}
    onEscape={() => (isZoomed ? resetZoom() : onClose())}
    lockTouch
  >
    {#snippet headerLead()}
      <p class="min-w-0 flex-1 truncate text-xs opacity-80 sm:text-sm">{title}</p>
    {/snippet}

    {#snippet headerActions()}
      {#if onDownload}
        <button
          type="button"
          class="h-9 rounded-lg bg-white/15 px-3 text-sm font-semibold transition-colors hover:bg-white/25"
          onclick={(e) => {
            e.stopPropagation();
            onDownload!();
          }}
        >
          {m.common_download_label()}
        </button>
      {/if}
    {/snippet}

    <div
      class="pointer-events-none relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden"
    >
      {#if showPrev && onPrev}
        <button
          type="button"
          class="pointer-events-auto absolute left-2 z-20 rounded-full bg-black/40 p-2.5 backdrop-blur-sm transition-colors hover:bg-black/60"
          onclick={(e) => {
            e.stopPropagation();
            handlePrev();
          }}
          aria-label={m.media_lightbox_prev_aria()}
        >
          <ChevronLeft size={26} strokeWidth={2.5} />
        </button>
      {/if}

      <!-- Transform wrapper: zoom + pan target -->
      <div
        bind:this={transformEl}
        role="presentation"
        class="pointer-events-auto relative z-10 flex h-full w-full items-center justify-center select-none"
        style="transform: translate({tx}px, {ty}px) scale({scale}); transform-origin: center; will-change: transform; touch-action: none; cursor: {isDragging
          ? 'grabbing'
          : isZoomed
            ? 'grab'
            : 'zoom-in'};"
        onclick={(e) => e.stopPropagation()}
        ondblclick={handleDoubleClick}
        onpointerdown={handlePointerDown}
        onpointermove={handlePointerMove}
        onpointerup={handlePointerUp}
        onpointercancel={handlePointerUp}
      >
        {@render children?.()}
      </div>

      {#if showNext && onNext}
        <button
          type="button"
          class="pointer-events-auto absolute right-2 z-20 rounded-full bg-black/40 p-2.5 backdrop-blur-sm transition-colors hover:bg-black/60"
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
          class="pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs font-semibold text-white/90 tabular-nums backdrop-blur-sm"
        >
          {scaleLabel}
        </div>
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
                onDotSelect!(i);
              }}
              class="h-2 w-2 rounded-full transition-all {i === dotIndex
                ? 'bg-white'
                : 'bg-white/40'}"
              aria-label={m.media_lightbox_dot_aria({ index: i + 1 })}
            ></button>
          {/each}
        </div>
      {/if}
    {/snippet}
  </FullScreenViewer>
{/if}
