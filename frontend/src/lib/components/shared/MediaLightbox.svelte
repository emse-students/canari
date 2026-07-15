<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ChevronLeft, ChevronRight, X } from '@lucide/svelte';
  import { portal } from '$lib/actions/portal';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { m } from '$lib/paraglide/messages';

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
   * Clamp (tx, ty) so the image never scrolls past its own edges.
   * When the image is smaller than the viewport it snaps to center.
   */
  function constrain(newTx: number, newTy: number): [number, number] {
    if (!transformEl || scale <= 1) return [0, 0];
    const parent = transformEl.parentElement;
    if (!parent) return [newTx, newTy];
    const elW = transformEl.offsetWidth;
    const elH = transformEl.offsetHeight;
    const pW = parent.clientWidth;
    const pH = parent.clientHeight;
    const maxTx = Math.max(0, (elW * scale - pW) / 2);
    const maxTy = Math.max(0, (elH * scale - pH) / 2);
    return [Math.max(-maxTx, Math.min(maxTx, newTx)), Math.max(-maxTy, Math.min(maxTy, newTy))];
  }

  /** Zoom around a pivot point expressed in element-center coordinates. */
  function zoomAt(newScale: number, pivotX: number, pivotY: number) {
    newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    const ratio = newScale / scale;
    const rawTx = tx * ratio + pivotX * (1 - ratio);
    const rawTy = ty * ratio + pivotY * (1 - ratio);
    scale = newScale;
    if (scale <= MIN_SCALE) {
      tx = 0;
      ty = 0;
    } else {
      [tx, ty] = constrain(rawTx, rawTy);
    }
    showIndicator();
  }

  // Wheel zoom handler (registered non-passively via $effect)
  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - rect.left - rect.width / 2;
    const py = e.clientY - rect.top - rect.height / 2;
    const delta = e.deltaY * (e.deltaMode === 1 ? 20 : 1);
    zoomAt(scale * Math.pow(0.999, delta), px, py);
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
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const rect = el!.getBoundingClientRect();
        zoomAt(
          scale * (dist / lastPinchDist),
          midX - rect.left - rect.width / 2,
          midY - rect.top - rect.height / 2
        );
        lastPinchDist = dist;
      } else if (isDragging && e.touches.length === 1) {
        e.preventDefault();
        [tx, ty] = constrain(
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
    [tx, ty] = constrain(
      dragStartTx + e.clientX - dragStartX,
      dragStartTy + e.clientY - dragStartY
    );
  }

  function handlePointerUp(e: PointerEvent) {
    if (e.pointerType === 'touch') return;
    isDragging = false;
  }

  // Double-click: toggle between 1× and 2.5×
  function handleDoubleClick(e: MouseEvent) {
    e.stopPropagation();
    const target = e.target as HTMLElement;
    if (target.closest('video, button')) return;
    if (isZoomed) {
      resetZoom();
    } else {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      zoomAt(2.5, e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (isZoomed) resetZoom();
      else onClose();
      return;
    }
    if (!isZoomed) {
      if (e.key === 'ArrowLeft' && showPrev && onPrev) {
        e.preventDefault();
        handlePrev();
      }
      if (e.key === 'ArrowRight' && showNext && onNext) {
        e.preventDefault();
        handleNext();
      }
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

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
  <div use:portal>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- Backdrop: click outside the card to close. Escape key is handled by the inner dialog. -->
    <div
      role="presentation"
      class="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 backdrop-blur-lg sm:p-4"
      style="touch-action: none;"
      onclick={onClose}
    >
      <!-- Floating card: full-screen on mobile, bounded on desktop -->
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabindex="-1"
        use:focusTrap
        class="relative flex flex-col w-full text-white overflow-hidden
               h-dvh sm:h-[90dvh] sm:max-w-[1400px]
               sm:rounded-xl sm:border sm:border-white/8
               bg-black/20 sm:bg-white/[0.04] sm:backdrop-blur-2xl
               sm:shadow-[0_20px_60px_rgba(0,0,0,0.7)]"
        style="touch-action: none;"
        onclick={(e) => e.stopPropagation()}
        transition:fly={{ y: 18, duration: 240, easing: cubicOut }}
      >
        <!-- Header -->
        <div
          class="flex shrink-0 items-center justify-between gap-3 px-3 sm:px-4 pb-2 sm:pb-3 border-b border-white/8 bg-gradient-to-b from-black/30 to-transparent"
          style="padding-top: max(0.75rem, env(safe-area-inset-top, 0.75rem));"
        >
          <p class="min-w-0 flex-1 truncate text-xs sm:text-sm opacity-80">{title}</p>
          <div class="flex items-center gap-2 shrink-0">
            {#if onDownload}
              <button
                type="button"
                class="px-3 h-9 rounded-lg bg-white/15 hover:bg-white/25 transition-colors text-sm font-semibold"
                onclick={(e) => {
                  e.stopPropagation();
                  onDownload!();
                }}
              >
                {m.common_download_label()}
              </button>
            {/if}
            <button
              type="button"
              class="p-2 rounded-lg bg-white/15 hover:bg-white/25 transition-colors"
              onclick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              aria-label="Fermer"
            >
              <X size={22} strokeWidth={2.5} />
            </button>
          </div>
        </div>

        <!-- Content area -->
        <div
          class="relative flex flex-1 min-h-0 w-full items-center justify-center pointer-events-none overflow-hidden"
        >
          {#if showPrev && onPrev}
            <button
              type="button"
              class="absolute left-2 z-20 p-2.5 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-sm transition-colors pointer-events-auto"
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
            class="relative z-10 flex h-full w-full items-center justify-center pointer-events-auto select-none"
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
              class="absolute right-2 z-20 p-2.5 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-sm transition-colors pointer-events-auto"
              onclick={(e) => {
                e.stopPropagation();
                handleNext();
              }}
              aria-label="Suivant"
            >
              <ChevronRight size={26} strokeWidth={2.5} />
            </button>
          {/if}

          <!-- Zoom level indicator -->
          {#if showZoomIndicator}
            <div
              transition:fade={{ duration: 200 }}
              class="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 px-3 py-1 rounded-full bg-black/60 backdrop-blur-sm text-white/90 text-xs font-semibold pointer-events-none tabular-nums"
            >
              {scaleLabel}
            </div>
          {/if}
        </div>

        <!-- Dots navigation -->
        {#if dotCount > 1 && onDotSelect}
          <div
            class="flex shrink-0 justify-center gap-1.5 pt-2 pointer-events-auto"
            style="padding-bottom: max(0.5rem, env(safe-area-inset-bottom, 0.5rem));"
          >
            {#each { length: dotCount } as _, i (i)}
              <button
                type="button"
                onclick={(e) => {
                  e.stopPropagation();
                  resetZoom();
                  onDotSelect!(i);
                }}
                class="w-2 h-2 rounded-full transition-all {i === dotIndex
                  ? 'bg-white'
                  : 'bg-white/40'}"
                aria-label="Image {i + 1}"
              ></button>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
