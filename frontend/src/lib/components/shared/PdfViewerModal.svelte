<script lang="ts">
  /**
   * Full-screen PDF reader for an already-decrypted document.
   *
   * Every page is rasterised with pdf.js (see `utils/pdfDocument.ts`) rather than embedded,
   * because Android's WebView has no PDF renderer and would show a blank frame - this is the
   * one rendering path that behaves identically on web, Android, iOS and desktop.
   *
   * Pages render lazily as they scroll into view, so opening a 200-page document costs one
   * page. A placeholder holds A4 proportions until its page lands: the real size is only
   * known once the page object is loaded, and loading every page up front to measure them
   * would defeat the laziness. The scrollbar therefore settles slightly as pages arrive.
   */
  import { tick, untrack } from 'svelte';
  import {
    anchorFraction,
    anchorScroll,
    nearestBoxIndex,
    nearestStepIndex,
    touchDistance,
    touchMidpoint,
  } from '$lib/utils/pinchZoom';
  import { X, ZoomIn, ZoomOut, Download, FileText } from '@lucide/svelte';
  import { portal } from '$lib/actions/portal';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import {
    openPdfDocument,
    releasePdfObjectUrl,
    type PdfDocument,
    type RenderedPdfPage,
  } from '$lib/utils/pdfDocument';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Object URL of the decrypted PDF. */
    url: string;
    /** Shown in the header; also what the download is named. */
    fileName: string;
    onClose: () => void;
    /** Omitted while the bytes are not available; renders the header download button. */
    onDownload?: () => void;
  }

  let { url, fileName, onClose, onDownload }: Props = $props();

  /** Render width multipliers, in order. 1 = fit the column width. */
  const ZOOM_STEPS = [1, 1.5, 2, 3];
  /** Hard cap on the rasterised width, mirroring the scale cap in `pdfDocument.ts`. */
  const MAX_RENDER_WIDTH = 2400;
  /** Reading width at zoom 1; wider than this a page column stops being readable. */
  const COLUMN_MAX_WIDTH = 900;

  let zoomIndex = $state(0);
  const zoom = $derived(ZOOM_STEPS[zoomIndex]);

  let pageCount = $state(0);
  let loadError = $state(false);
  /** Rasterised bitmap per page, 0-based; `null` until that page has been rendered. */
  let pages = $state<(RenderedPdfPage | null)[]>([]);
  /**
   * Last known height/width per page, kept ACROSS a re-render so the placeholder that replaces
   * a page during a zoom keeps that page's real proportions instead of falling back to A4.
   */
  const knownRatios: Record<number, number> = {};
  /**
   * CSS width each page's current bitmap was rasterised FOR, per 0-based index.
   *
   * Not derivable from the bitmap: `RenderedPdfPage.width` is the canvas size in DEVICE pixels
   * (`maxWidth * devicePixelRatio`, capped), so comparing it against `renderWidth` would compare
   * two different units and re-render every page forever on any screen with a dpr above 1.
   */
  let renderedAt: Record<number, number> = {};
  /** Width of the scroll viewport, which is what "fit" means at zoom 1. */
  let viewportWidth = $state(0);

  const columnWidth = $derived(Math.min(COLUMN_MAX_WIDTH, Math.max(320, viewportWidth)));

  /**
   * The only two scales pages are ever rasterised at.
   *
   * Rasterising per zoom STEP meant four passes over the document, and a pinch through 1.5 and 2
   * on the way to 3 paid for all of them - which is heavy on a phone and, since each pass swapped
   * the bitmaps out, made the page flash empty repeatedly. Two levels bound that to at most one
   * re-render for any gesture: `1` for the fit-width reading view, and the LARGEST step for
   * everything above it. The intermediate steps then display a bitmap rasterised bigger than they
   * need, i.e. downscaled by the browser, which loses nothing visually; only a zoom past the last
   * step (impossible here, it is the cap) would ever upscale.
   */
  const RENDER_ZOOMS = [ZOOM_STEPS[0], ZOOM_STEPS[ZOOM_STEPS.length - 1]];
  const renderZoom = $derived(zoom <= RENDER_ZOOMS[0] ? RENDER_ZOOMS[0] : RENDER_ZOOMS[1]);

  /**
   * Width each page is rasterised at. Zooming re-renders rather than upscaling a bitmap, so the
   * text stays sharp - which is the point of zooming into a document on a phone.
   */
  const renderWidth = $derived(Math.min(MAX_RENDER_WIDTH, columnWidth * renderZoom));

  let doc = $state<PdfDocument | null>(null);

  // Open the document once per URL; everything rendered from it dies with it.
  $effect(() => {
    const source = url;
    let cancelled = false;
    let opened: PdfDocument | null = null;

    loadError = false;
    pageCount = 0;
    pages = [];
    renderedAt = {};

    openPdfDocument(source)
      .then((handle) => {
        if (cancelled) {
          void handle.destroy();
          return;
        }
        opened = handle;
        doc = handle;
        pageCount = handle.numPages;
        pages = Array.from({ length: handle.numPages }, () => null);
        console.debug(`[pdfViewer] opened "${fileName}" (${handle.numPages} pages)`);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[pdfViewer] document could not be opened', err);
        loadError = true;
      });

    return () => {
      cancelled = true;
      doc = null;
      void opened?.destroy();
      // Every bitmap was produced from this document, so it dies with it - on close as much
      // as on a URL change. `untrack` because this effect must depend on `url` ALONE: reading
      // `pages` here would re-run the teardown on every page that lands and revoke the object
      // URLs the images are currently displaying.
      untrack(() => {
        for (const page of pages) releasePdfObjectUrl(page?.url ?? null);
      });
    };
  });

  // A zoom (or a viewport resize) makes every bitmap the wrong size, so whatever is on screen is
  // re-rendered - but the CURRENT bitmaps stay on screen while that happens. Dropping them first
  // blanked the document mid-gesture, and the placeholder that replaced them is an `aspect-ratio`
  // box with `overflow-hidden`, so a page whose proportions were not yet known was also visibly
  // CUT. An old bitmap is simply the right image at the wrong resolution: the browser scales it,
  // and it is replaced in place the moment the sharp one lands.
  // Same `untrack` reason as above - the dependency is the width, and only the width. The observer
  // cannot do this on its own: a page that is already intersecting produces no new callback, so
  // nothing would ever ask for it again.
  $effect(() => {
    const width = renderWidth;
    untrack(() => {
      if (!pages.some((page) => page !== null)) return;
      console.debug(
        `[pdfViewer] re-rendering visible pages at ${width}px, keeping current bitmaps`
      );
      for (const [index, isOnScreen] of Object.entries(onScreen)) {
        if (isOnScreen) void renderPage(Number(index));
      }
    });
  });

  /** 0-based page indices currently rasterising. Deliberately NOT reactive: nothing renders it. */
  const rendering: Record<number, boolean> = {};
  /** 0-based page indices currently within a screen of the viewport. Not reactive either. */
  const onScreen: Record<number, boolean> = {};

  /**
   * Rasterises one 0-based page index, unless it is in flight or already at the wanted width.
   *
   * The width is the guard rather than "has a bitmap at all", because a zoom does not remove the
   * old bitmaps any more: a page held at the previous width must be re-rendered when it comes back
   * on screen, and one already at this width must not be rendered twice.
   */
  async function renderPage(index: number) {
    const handle = doc;
    if (!handle || rendering[index]) return;
    const width = renderWidth;
    if (pages[index] && renderedAt[index] === width) return;
    rendering[index] = true;
    try {
      const rendered = await handle.renderPage(index + 1, width);
      knownRatios[index] = rendered.height / rendered.width;
      // The zoom (or the document) may have changed while this page was rasterising; a
      // bitmap for a width nobody displays any more is dropped rather than shown.
      if (doc !== handle || width !== renderWidth) {
        releasePdfObjectUrl(rendered.url);
        return;
      }
      const next = [...pages];
      const previous = next[index];
      next[index] = rendered;
      pages = next;
      renderedAt[index] = width;
      // Only once the swap has been flushed is the old bitmap certainly off screen. Revoking it
      // before that races the `<img>` still pointing at it.
      if (previous) {
        await tick();
        releasePdfObjectUrl(previous.url);
      }
    } catch (err) {
      console.error(`[pdfViewer] page ${index + 1} could not be rendered`, err);
    } finally {
      delete rendering[index];
    }
  }

  /**
   * Renders a page when it comes within a screen of the viewport. Attached per placeholder
   * so a page that scrolls away never costs anything it has not already cost.
   */
  function visible(node: HTMLElement, index: number) {
    const observer = new IntersectionObserver(
      (entries) => {
        const isOnScreen = entries.some((entry) => entry.isIntersecting);
        onScreen[index] = isOnScreen;
        if (isOnScreen) void renderPage(index);
      },
      { rootMargin: '100% 0px' }
    );
    observer.observe(node);
    return {
      destroy: () => {
        delete onScreen[index];
        observer.disconnect();
      },
    };
  }

  /** A4 proportions until a page has been rendered once; its own afterwards. */
  function placeholderRatio(index: number): number {
    return knownRatios[index] ?? 1.414;
  }

  /**
   * Pinch-to-zoom.
   *
   * The page is a rasterised bitmap re-rendered per zoom level, so a pinch cannot simply scale a
   * canvas: the gesture is tracked live as a CSS transform (instant, no rasterising) and SETTLED on
   * release to the nearest {@link ZOOM_STEPS} entry, which is what triggers the re-render at the
   * new width. Anything else either stutters - rasterising every frame of a gesture - or leaves the
   * text blurry, and sharp text is the entire reason pages are re-rendered rather than upscaled.
   *
   * The app disables the WebView's own page zoom (it is a phone application, not a document), so
   * without this the pinch reached nothing at all and the buttons were the only way in.
   */
  let pinchStartDistance = 0;
  let pinchStartZoom = 1;
  /** Live scale applied during a gesture; 1 whenever no pinch is in progress. */
  let pinchScale = $state(1);
  /** The scroll container, which owns the overflow a zoom creates. */
  let scrollEl = $state<HTMLElement | null>(null);
  /** The page column, whose transform previews the gesture. */
  let columnEl = $state<HTMLElement | null>(null);

  /**
   * Where the fingers are, in the column's own coordinates, so the live preview scales ABOUT that
   * point instead of about the top edge. Reported on device 2026-08-07: the zoom worked but "ca
   * augmente pas a l'endroit qu'on veut" - scaling about `origin-top` slides whatever you pinched
   * out from under your fingers.
   */
  let pinchOrigin = $state<{ x: number; y: number } | null>(null);
  /** Focal point relative to the scroll container, kept for the settle-time scroll correction. */
  let pinchFocal: { x: number; y: number } | null = null;
  /**
   * WHICH page was pinched, and where within it. The settle corrects the scroll by re-measuring
   * this page's box rather than by multiplying the old scroll by the zoom ratio: the gutters
   * between pages and the container's padding are fixed CSS lengths that do NOT scale, so a ratio
   * overshoots by (ratio - 1) x (padding + gutters above the page) - 48 px on page 2 at x3, and
   * one gutter more for every page deeper in.
   */
  let pinchAnchor: { index: number; fracX: number; fracY: number } | null = null;
  /**
   * Suppresses the hand-back transition while the settle measures. The transform animates back to
   * `scale(1)` over 120 ms, and `getBoundingClientRect` reports the ANIMATING box - measuring the
   * anchor mid-transition would read a box that is still partly the gesture's preview.
   */
  let settling = $state(false);

  const pinchOriginCss = $derived(
    pinchOrigin ? `${pinchOrigin.x}px ${pinchOrigin.y}px` : 'top center'
  );

  /** A page's box in the scroll container's coordinates, or `null` if it is not laid out. */
  function pageBox(index: number) {
    const el = columnEl?.children[index] as HTMLElement | undefined;
    const boxRect = scrollEl?.getBoundingClientRect();
    if (!el || !boxRect) return null;
    const r = el.getBoundingClientRect();
    return {
      left: r.left - boxRect.left,
      top: r.top - boxRect.top,
      width: r.width,
      height: r.height,
    };
  }

  function handleTouchStart(e: TouchEvent) {
    if (e.touches.length !== 2) return;
    pinchStartDistance = touchDistance(e.touches[0], e.touches[1]);
    pinchStartZoom = zoom;
    pinchScale = 1;

    // Both are read while `pinchScale` is still 1, so the rects are the untransformed layout -
    // measuring them mid-gesture would fold the preview's own transform back into the origin.
    const mid = touchMidpoint(e.touches[0], e.touches[1]);
    const colRect = columnEl?.getBoundingClientRect();
    pinchOrigin = colRect ? { x: mid.x - colRect.left, y: mid.y - colRect.top } : null;
    const boxRect = scrollEl?.getBoundingClientRect();
    pinchFocal = boxRect ? { x: mid.x - boxRect.left, y: mid.y - boxRect.top } : null;

    // Which page the fingers are on, so the settle can re-measure that page rather than trust a
    // scale ratio the surrounding layout does not obey.
    pinchAnchor = null;
    const children = columnEl ? Array.from(columnEl.children) : [];
    if (pinchFocal && children.length > 0 && boxRect) {
      const boxes = children.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top - boxRect.top, height: r.height };
      });
      const index = nearestBoxIndex(pinchFocal.y, boxes);
      const box = index >= 0 ? pageBox(index) : null;
      const fraction = box ? anchorFraction(pinchFocal, box) : null;
      if (fraction) pinchAnchor = { index, ...fraction };
    }
  }

  function handleTouchMove(e: TouchEvent) {
    if (e.touches.length !== 2 || pinchStartDistance === 0) return;
    // Owning the gesture: otherwise the scroll container pans underneath the pinch.
    e.preventDefault();
    const ratio = touchDistance(e.touches[0], e.touches[1]) / pinchStartDistance;
    // Clamped to what the steps can actually settle on, so the preview never promises a zoom the
    // release cannot deliver.
    const target = Math.min(
      ZOOM_STEPS[ZOOM_STEPS.length - 1],
      Math.max(ZOOM_STEPS[0], pinchStartZoom * ratio)
    );
    pinchScale = target / pinchStartZoom;
  }

  async function handleTouchEnd(e: TouchEvent) {
    if (pinchStartDistance === 0 || e.touches.length >= 2) return;
    const settled = pinchStartZoom * pinchScale;
    const nearest = nearestStepIndex(settled, ZOOM_STEPS);
    const to = ZOOM_STEPS[nearest];
    const focal = pinchFocal;
    const anchor = pinchAnchor;

    pinchStartDistance = 0;
    pinchScale = 1;
    pinchFocal = null;
    pinchAnchor = null;

    if (nearest === zoomIndex) {
      pinchOrigin = null;
      return;
    }
    console.debug(
      `[pdfViewer] pinch settled at x${to} (anchor ${anchor ? `page ${anchor.index}` : 'unavailable'})`
    );

    if (!scrollEl || !focal || !anchor) {
      zoomIndex = nearest;
      pinchOrigin = null;
      return;
    }

    // The column is re-laid out at the new width on the next flush; only then can the pinched page
    // be re-measured, and that measurement is what actually keeps the pinched point in place. The
    // live transform-origin above and this share one focal point, so the preview hands over
    // without a visible jump.
    settling = true;
    zoomIndex = nearest;
    await tick();
    const box = pageBox(anchor.index);
    if (box) {
      const next = anchorScroll({
        scrollLeft: scrollEl.scrollLeft,
        scrollTop: scrollEl.scrollTop,
        focalX: focal.x,
        focalY: focal.y,
        anchor: box,
        fracX: anchor.fracX,
        fracY: anchor.fracY,
        maxScrollLeft: scrollEl.scrollWidth - scrollEl.clientWidth,
        maxScrollTop: scrollEl.scrollHeight - scrollEl.clientHeight,
      });
      scrollEl.scrollLeft = next.scrollLeft;
      scrollEl.scrollTop = next.scrollTop;
    } else {
      console.debug(`[pdfViewer] anchor page ${anchor.index} vanished on relayout, scroll kept`);
    }
    settling = false;
    pinchOrigin = null;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div use:portal>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- Backdrop: click outside the card to close. Escape is handled above. -->
  <div
    role="presentation"
    class="fixed inset-0 z-300 flex items-center justify-center bg-black/70 backdrop-blur-lg sm:p-4"
    onclick={onClose}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-label={fileName}
      tabindex="-1"
      use:focusTrap
      class="relative flex flex-col w-full text-white overflow-hidden
             h-dvh sm:h-[90dvh] sm:max-w-275
             sm:rounded-xl sm:border sm:border-white/8
             bg-black/20 sm:bg-white/4 sm:backdrop-blur-2xl
             sm:shadow-[0_20px_60px_rgba(0,0,0,0.7)]"
      onclick={(e) => e.stopPropagation()}
      transition:fly={{ y: 18, duration: 240, easing: cubicOut }}
    >
      <!-- Header -->
      <div
        class="flex shrink-0 items-center justify-between gap-3 px-3 sm:px-4 pb-2 sm:pb-3 border-b border-white/8 bg-linear-to-b from-black/30 to-transparent"
        style="padding-top: max(0.75rem, env(safe-area-inset-top, 0.75rem));"
      >
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <FileText size={16} strokeWidth={2.5} class="shrink-0 opacity-70" />
          <p class="min-w-0 flex-1 truncate text-xs sm:text-sm opacity-80">{fileName}</p>
          {#if pageCount > 0}
            <span class="shrink-0 text-[0.7rem] tabular-nums opacity-50">
              {m.pdf_viewer_page_count({ count: pageCount })}
            </span>
          {/if}
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            class="p-2 rounded-lg bg-white/15 hover:bg-white/25 transition-colors disabled:opacity-30"
            disabled={zoomIndex === 0}
            onclick={() => (zoomIndex = Math.max(0, zoomIndex - 1))}
            aria-label={m.pdf_viewer_zoom_out()}
          >
            <ZoomOut size={18} strokeWidth={2.5} />
          </button>
          <button
            type="button"
            class="p-2 rounded-lg bg-white/15 hover:bg-white/25 transition-colors disabled:opacity-30"
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            onclick={() => (zoomIndex = Math.min(ZOOM_STEPS.length - 1, zoomIndex + 1))}
            aria-label={m.pdf_viewer_zoom_in()}
          >
            <ZoomIn size={18} strokeWidth={2.5} />
          </button>
          {#if onDownload}
            <button
              type="button"
              class="p-2 rounded-lg bg-white/15 hover:bg-white/25 transition-colors"
              onclick={onDownload}
              aria-label={m.common_download_label()}
              title={m.common_download_label()}
            >
              <Download size={18} strokeWidth={2.5} />
            </button>
          {/if}
          <button
            type="button"
            class="p-2 rounded-lg bg-white/15 hover:bg-white/25 transition-colors"
            onclick={onClose}
            aria-label={m.common_close_label()}
          >
            <X size={22} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      <!-- Pages -->
      <!-- `document` rather than a bare div: the pages ARE the document being read, and the pinch
           handlers below need the element to carry a role. -->
      <div
        role="document"
        class="flex-1 min-h-0 overflow-auto overscroll-contain px-2 sm:px-4 py-3 touch-pan-x touch-pan-y"
        bind:this={scrollEl}
        bind:clientWidth={viewportWidth}
        ontouchstart={handleTouchStart}
        ontouchmove={handleTouchMove}
        ontouchend={handleTouchEnd}
        ontouchcancel={handleTouchEnd}
      >
        {#if loadError}
          <div class="flex h-full flex-col items-center justify-center gap-3 text-white/70">
            <FileText size={40} strokeWidth={1.5} />
            <p class="text-sm">{m.pdf_viewer_error()}</p>
          </div>
        {:else if pageCount === 0}
          <div class="flex h-full items-center justify-center">
            <div
              class="h-8 w-8 animate-spin rounded-full border-4 border-white/20 border-t-white/70"
            ></div>
          </div>
        {:else}
          <!-- Zooming widens the column past the viewport; the scroll container above owns
               the resulting horizontal scroll, so pages never scroll independently. -->
          <!-- `pinchScale` previews the gesture without rasterising; it is 1 at rest, so the
               transform is inert outside a pinch and the settled zoom does the real work. -->
          <div
            bind:this={columnEl}
            class="mx-auto flex flex-col items-center gap-3"
            style="width: {zoom * 100}%; max-width: {COLUMN_MAX_WIDTH * zoom}px;
                   transform: scale({pinchScale});
                   transform-origin: {pinchOriginCss};
                   transition: {pinchScale === 1 && !settling
              ? 'transform 120ms ease-out'
              : 'none'};"
          >
            {#each pages as page, index (index)}
              <div
                use:visible={index}
                class="w-full overflow-hidden rounded-lg bg-white shadow-lg"
                style={page ? '' : `aspect-ratio: 1 / ${placeholderRatio(index)};`}
              >
                {#if page}
                  <img
                    src={page.url}
                    alt={m.pdf_viewer_page_alt({ page: index + 1, total: pageCount })}
                    class="block h-auto w-full"
                  />
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>
