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
  import { untrack } from 'svelte';
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
  /** Width of the scroll viewport, which is what "fit" means at zoom 1. */
  let viewportWidth = $state(0);

  const columnWidth = $derived(Math.min(COLUMN_MAX_WIDTH, Math.max(320, viewportWidth)));

  /**
   * Width each page is rasterised at. Zooming re-renders rather than upscaling a bitmap, so
   * the text stays sharp - which is the point of zooming into a document on a phone.
   */
  const renderWidth = $derived(Math.min(MAX_RENDER_WIDTH, columnWidth * zoom));

  let doc = $state<PdfDocument | null>(null);

  // Open the document once per URL; everything rendered from it dies with it.
  $effect(() => {
    const source = url;
    let cancelled = false;
    let opened: PdfDocument | null = null;

    loadError = false;
    pageCount = 0;
    pages = [];

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

  // A zoom (or a viewport resize) invalidates every bitmap: drop them and re-render whatever
  // is on screen right now. Same `untrack` reason as above - the dependency is the width, and
  // only the width. The observer cannot do this on its own: a page that is already
  // intersecting produces no new callback, so nothing would ever ask for it again.
  $effect(() => {
    const width = renderWidth;
    untrack(() => {
      if (!pages.some((page) => page !== null)) return;
      console.debug(`[pdfViewer] re-rendering pages at ${width}px`);
      for (const page of pages) releasePdfObjectUrl(page?.url ?? null);
      pages = Array.from({ length: pageCount }, () => null);
      for (const [index, isOnScreen] of Object.entries(onScreen)) {
        if (isOnScreen) void renderPage(Number(index));
      }
    });
  });

  /** 0-based page indices currently rasterising. Deliberately NOT reactive: nothing renders it. */
  const rendering: Record<number, boolean> = {};
  /** 0-based page indices currently within a screen of the viewport. Not reactive either. */
  const onScreen: Record<number, boolean> = {};

  /** Rasterises one 0-based page index, unless it is already rendered or in flight. */
  async function renderPage(index: number) {
    const handle = doc;
    if (!handle || pages[index] !== null || rendering[index]) return;
    rendering[index] = true;
    const width = renderWidth;
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
      next[index] = rendered;
      pages = next;
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

  function touchDistance(touches: TouchList): number {
    const [a, b] = [touches[0], touches[1]];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function handleTouchStart(e: TouchEvent) {
    if (e.touches.length !== 2) return;
    pinchStartDistance = touchDistance(e.touches);
    pinchStartZoom = zoom;
    pinchScale = 1;
  }

  function handleTouchMove(e: TouchEvent) {
    if (e.touches.length !== 2 || pinchStartDistance === 0) return;
    // Owning the gesture: otherwise the scroll container pans underneath the pinch.
    e.preventDefault();
    const ratio = touchDistance(e.touches) / pinchStartDistance;
    // Clamped to what the steps can actually settle on, so the preview never promises a zoom the
    // release cannot deliver.
    const target = Math.min(
      ZOOM_STEPS[ZOOM_STEPS.length - 1],
      Math.max(ZOOM_STEPS[0], pinchStartZoom * ratio)
    );
    pinchScale = target / pinchStartZoom;
  }

  function handleTouchEnd(e: TouchEvent) {
    if (pinchStartDistance === 0 || e.touches.length >= 2) return;
    const settled = pinchStartZoom * pinchScale;
    let nearest = 0;
    for (let i = 1; i < ZOOM_STEPS.length; i++) {
      if (Math.abs(ZOOM_STEPS[i] - settled) < Math.abs(ZOOM_STEPS[nearest] - settled)) nearest = i;
    }
    pinchStartDistance = 0;
    pinchScale = 1;
    if (nearest !== zoomIndex) {
      console.debug(`[pdfViewer] pinch settled at x${ZOOM_STEPS[nearest]}`);
      zoomIndex = nearest;
    }
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
            class="mx-auto flex flex-col items-center gap-3 origin-top"
            style="width: {zoom * 100}%; max-width: {COLUMN_MAX_WIDTH * zoom}px;
                   transform: scale({pinchScale});
                   transition: {pinchScale === 1 ? 'transform 120ms ease-out' : 'none'};"
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
