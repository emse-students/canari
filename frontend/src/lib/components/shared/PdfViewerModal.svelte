<script lang="ts">
  /**
   * Full-screen PDF reader for an already-decrypted document.
   *
   * Every page is rasterised with pdf.js (see `utils/pdfDocument.ts`) rather than embedded,
   * because Android's WebView has no PDF renderer and would show a blank frame - this is the
   * one rendering path that behaves identically on web, Android, iOS and desktop.
   *
   * Pages render lazily as they come near the viewport, through a bounded queue
   * (`utils/pdfRenderQueue.ts`): visible pages first, at most two renders at once, and a render
   * for a page that has left the window is cancelled. Each page first gets a small PREVIEW, kept
   * for the life of the document, then a SHARP bitmap held under a byte budget, the farthest
   * dropped first - so a page is blurry for one cheap pass rather than blank, and a long document
   * cannot exhaust a phone's memory. A placeholder holds A4 proportions until a page's own are
   * known, so the scrollbar settles slightly as pages arrive.
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
  import { ZoomIn, ZoomOut, Download, FileText } from '@lucide/svelte';
  import FullScreenViewer from './FullScreenViewer.svelte';
  import {
    openPdfDocument,
    PdfRenderCancelled,
    releasePdfCanvas,
    type PdfDocument,
    type PdfTextRun,
    type RenderedPdfCanvas,
  } from '$lib/utils/pdfDocument';
  import {
    bitmapBytes,
    planEviction,
    PREVIEW_PIXEL_BUDGET,
    RenderQueue,
    VIEWER_BYTE_BUDGET,
    wantedJobs,
    type PageNeed,
    type RenderJob,
    type RunningRender,
    type VisibleRange,
  } from '$lib/utils/pdfRenderQueue';
  import { Log } from '$lib/utils/Log';
  import PdfTextLayer from './PdfTextLayer.svelte';
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
  /** Reading width at zoom 1; wider than this a page column stops being readable. */
  const COLUMN_MAX_WIDTH = 900;
  /**
   * How long the zoom must stay put before visible pages are re-rendered sharp. Until then the
   * current bitmaps are simply stretched by CSS (the column widens, each canvas is `width: 100%`),
   * so walking 1 -> 1.5 -> 2 -> 3 on the buttons costs ONE re-render, at the step it ends on.
   */
  const ZOOM_SETTLE_MS = 250;

  let zoomIndex = $state(0);
  const zoom = $derived(ZOOM_STEPS[zoomIndex]);

  let pageCount = $state(0);
  let loadError = $state(false);
  /**
   * Sharp bitmap per page, 0-based; `null` until rendered or once evicted.
   *
   * `$state.raw` because a canvas must never be proxied, and every change is a whole new array.
   */
  let sharp = $state.raw<(RenderedPdfCanvas | null)[]>([]);
  /** Low-resolution preview per page, 0-based; kept for the life of the document. */
  let previews = $state.raw<(RenderedPdfCanvas | null)[]>([]);
  /**
   * Selectable text per page, 0-based; `null` until extracted.
   *
   * Kept apart from the bitmaps because the two have different lifetimes: a bitmap is replaced on
   * every zoom and the text never changes, so one extraction serves the whole session.
   */
  let pageTexts = $state<(PdfTextRun[] | null)[]>([]);
  /**
   * Last known height/width per page, kept ACROSS a re-render so the placeholder keeps that page's
   * real proportions instead of falling back to A4.
   */
  let knownRatios = $state<Record<number, number>>({});
  /**
   * CSS width each page's sharp bitmap was rasterised FOR, per 0-based index.
   *
   * Not derivable from the bitmap: its size is in DEVICE pixels and capped by the pixel budget, so
   * comparing it against `renderWidth` would compare two different units and re-render forever.
   */
  let renderedAt: Record<number, number> = {};
  /** Width of the scroll viewport, which is what "fit" means at zoom 1. */
  let viewportWidth = $state(0);
  /**
   * Rendered width of the page column, which every page is exactly as wide as.
   *
   * ONE binding for the whole document rather than one per page: it is the same number for all of
   * them, and it is what turns a text run's page-fraction box into CSS pixels. It tracks the zoom
   * on its own, since the zoom is what changes the column's width.
   */
  let columnInnerWidth = $state(0);

  const columnWidth = $derived(Math.min(COLUMN_MAX_WIDTH, Math.max(320, viewportWidth)));

  /**
   * CSS width each page is rasterised for. The bitmap's PIXEL size is then bounded by the per-page
   * budget in `pdfRenderQueue.ts`, which is what keeps a x3 zoom affordable on a phone.
   */
  const renderWidth = $derived(columnWidth * zoom);

  // `$state.raw`: a deep proxy of the handle would never be `===` the handle the queue holds, and
  // every finished render would be dropped as belonging to a closed document.
  let doc = $state.raw<PdfDocument | null>(null);

  /**
   * 0-based indices within a screen of the viewport. Reactive, because it also decides which pages
   * carry their text layer: hundreds of absolutely placed spans per page, and a zoom re-lays out
   * every mounted one. Kept on all 81 pages of a scan after a fling, that froze each zoom click for
   * 11-13 s on a Mi 9T.
   */
  const near = $state<Record<number, true>>({});
  /** 0-based indices actually intersecting the viewport. Not reactive: nothing renders it. */
  const visible: Record<number, true> = {};

  /** The render queue of the open document; replaced with it. */
  let queue: RenderQueue | null = null;

  /** Inclusive range of what is on screen; empty (`first > last`) before anything is laid out. */
  function visibleRange(): VisibleRange {
    const shown = Object.keys(visible).map(Number);
    if (shown.length === 0) return { first: 0, last: -1 };
    return { first: Math.min(...shown), last: Math.max(...shown) };
  }

  // Open the document once per URL; everything rendered from it dies with it.
  $effect(() => {
    const source = url;
    let cancelled = false;
    let opened: PdfDocument | null = null;

    loadError = false;
    pageCount = 0;
    sharp = [];
    previews = [];
    pageTexts = [];
    renderedAt = {};

    openPdfDocument(source)
      .then((handle) => {
        if (cancelled) {
          void handle.destroy();
          return;
        }
        opened = handle;
        doc = handle;
        queue = new RenderQueue((job) => startRender(handle, job));
        pageCount = handle.numPages;
        sharp = Array.from({ length: handle.numPages }, () => null);
        previews = Array.from({ length: handle.numPages }, () => null);
        pageTexts = Array.from({ length: handle.numPages }, () => null);
        Log.d('pdfViewer:opened', { fileName, pages: handle.numPages });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[pdfViewer] document could not be opened', err);
        loadError = true;
      });

    return () => {
      cancelled = true;
      queue?.clear();
      queue = null;
      doc = null;
      void opened?.destroy();
      // Every bitmap was produced from this document, so it dies with it - on close as much as on
      // a URL change. `untrack` because this effect must depend on `url` ALONE.
      untrack(() => {
        for (const page of sharp) releasePdfCanvas(page?.canvas);
        for (const page of previews) releasePdfCanvas(page?.canvas);
      });
    };
  });

  /**
   * Starts one queued render and wires its outcome into the page arrays.
   *
   * The current bitmap stays on screen until its replacement lands: an old bitmap is the right
   * image at the wrong resolution, which is strictly better than a blank or cut page.
   */
  function startRender(handle: PdfDocument, job: RenderJob): RunningRender {
    const render = handle.renderPage(
      job.index + 1,
      job.kind === 'preview'
        ? { cssWidth: columnWidth, maxPixels: PREVIEW_PIXEL_BUDGET }
        : { cssWidth: job.width }
    );
    const done = render.promise.then(
      (rendered) => accept(handle, job, rendered),
      (err) => {
        if (err instanceof PdfRenderCancelled) {
          Log.d('pdfViewer:renderCancelled', { page: job.index + 1, kind: job.kind });
          return;
        }
        console.error(`[pdfViewer] page ${job.index + 1} could not be rendered`, err);
      }
    );
    return { cancel: render.cancel, done };
  }

  /** Puts a finished render on screen, or frees it if its document has gone. */
  async function accept(handle: PdfDocument, job: RenderJob, rendered: RenderedPdfCanvas) {
    if (doc !== handle) {
      Log.d('pdfViewer:renderForClosedDocument', { page: job.index + 1, kind: job.kind });
      releasePdfCanvas(rendered.canvas);
      return;
    }
    knownRatios[job.index] = rendered.height / rendered.width;
    const isPreview = job.kind === 'preview';
    const next = [...(isPreview ? previews : sharp)];
    const previous = next[job.index];
    next[job.index] = rendered;
    if (isPreview) {
      previews = next;
    } else {
      sharp = next;
      renderedAt[job.index] = job.width;
    }
    // Only once the swap has been flushed is the old canvas certainly out of the page.
    if (previous) {
      await tick();
      releasePdfCanvas(previous.canvas);
    }
    if (!isPreview) evictOverBudget();
  }

  /** Drops the sharp bitmaps farthest from the screen until the rest fit the byte budget. */
  function evictOverBudget() {
    const resident = sharp.flatMap((page, index) =>
      page ? [{ index, bytes: bitmapBytes(page.width, page.height) }] : []
    );
    const evict = planEviction(resident, VIEWER_BYTE_BUDGET, visibleRange());
    if (evict.length === 0) return;
    Log.d('pdfViewer:evict', { pages: evict.map((i) => i + 1) });
    const next = [...sharp];
    const freed: RenderedPdfCanvas[] = [];
    for (const index of evict) {
      const page = next[index];
      if (page) freed.push(page);
      next[index] = null;
      delete renderedAt[index];
      doc?.releasePage(index + 1);
    }
    sharp = next;
    void tick().then(() => {
      for (const page of freed) releasePdfCanvas(page.canvas);
    });
  }

  /**
   * Pages that left the near window since the last pass, whose pdf.js caches are dropped AFTER the
   * queue has cancelled their renders - pdf.js refuses to clean a page that is still rendering.
   */
  let leftWindow: number[] = [];

  /** Tells the queue what is wanted now, from what is near and visible. */
  function schedule() {
    if (!queue) return;
    const needs: PageNeed[] = Object.keys(near)
      .map(Number)
      .map((index) => ({
        index,
        hasPreview: previews[index] != null,
        sharpWidth: sharp[index] ? (renderedAt[index] ?? null) : null,
      }));
    queue.want(wantedJobs(needs, visibleRange(), renderWidth, zoom === ZOOM_STEPS[0]));
    for (const index of leftWindow) if (!near[index]) doc?.releasePage(index + 1);
    leftWindow = [];
  }

  /**
   * Coalesces the bursts of intersection callbacks a scroll produces into one scheduling pass per
   * frame - a fling crosses many pages, and each crossing would otherwise re-plan the whole queue.
   */
  let scheduleFrame = 0;
  function scheduleSoon() {
    if (scheduleFrame) return;
    scheduleFrame = requestAnimationFrame(() => {
      scheduleFrame = 0;
      schedule();
    });
  }

  // A zoom (or a viewport resize) makes the sharp bitmaps the wrong size. They stay on screen,
  // stretched by CSS, and the visible pages are re-rendered once the zoom has stopped moving.
  // `untrack` because the dependency is the width, and only the width.
  $effect(() => {
    const width = renderWidth;
    const timer = setTimeout(() => {
      untrack(() => {
        Log.d('pdfViewer:zoomSettled', { width });
        schedule();
      });
    }, ZOOM_SETTLE_MS);
    return () => clearTimeout(timer);
  });

  /** 0-based page indices whose text is being extracted. Not reactive: nothing renders it. */
  const extracting: Record<number, boolean> = {};

  /**
   * Extracts one page's selectable text, once for the life of the document.
   *
   * There is no width to guard on - the runs are in page fractions, so they are already correct at
   * every zoom. The guard is therefore simply "do we have it".
   */
  async function loadPageText(index: number) {
    const handle = doc;
    if (!handle || extracting[index] || pageTexts[index]) return;
    extracting[index] = true;
    try {
      const runs = await handle.getPageText(index + 1);
      // The document may have been closed or swapped while this was in flight.
      if (doc !== handle) return;
      const next = [...pageTexts];
      next[index] = runs;
      pageTexts = next;
    } catch (err) {
      // A page whose text cannot be extracted still READS - it is the bitmap that matters, and the
      // layer is an enhancement. Logged rather than surfaced, but never swallowed silently: a
      // document where nothing is selectable is a fault worth being able to find afterwards.
      console.warn(`[pdfViewer] page ${index + 1} text could not be extracted`, err);
    } finally {
      delete extracting[index];
    }
  }

  /**
   * Tracks each page placeholder against two observers: within a screen of the viewport ("near",
   * worth rendering ahead) and actually on screen ("visible", rendered first and never evicted).
   * A page leaving the near window also has its pdf.js decoded images dropped, on the next pass.
   */
  function observePage(node: HTMLElement, index: number) {
    const nearObserver = new IntersectionObserver(
      (entries) => {
        const isNear = entries.some((entry) => entry.isIntersecting);
        if (isNear) {
          near[index] = true;
          void loadPageText(index);
        } else if (near[index]) {
          delete near[index];
          leftWindow.push(index);
        }
        scheduleSoon();
      },
      // ROOTED ON THE SCROLL CONTAINER. Against the viewport, a page below the container's visible
      // area is clipped by the container's own overflow before the margin is applied, so the margin
      // did nothing (measured in Chrome 2026-10-11: a page 0.3 screens below the fold was never
      // requested until it scrolled in) - "near" meant "visible".
      { root: scrollEl, rootMargin: '100% 0px' }
    );
    const visibleObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) visible[index] = true;
        else delete visible[index];
        scheduleSoon();
      },
      { root: scrollEl }
    );
    nearObserver.observe(node);
    visibleObserver.observe(node);
    return {
      destroy: () => {
        delete near[index];
        delete visible[index];
        nearObserver.disconnect();
        visibleObserver.disconnect();
      },
    };
  }

  /**
   * Shows one page's canvas inside its slot - the sharp one when there is one, else the preview.
   * The canvas is moved, never copied: it IS the bitmap, and a copy would hold the pixels twice.
   */
  function showCanvas(node: HTMLElement, shown: { canvas: HTMLCanvasElement; label: string }) {
    const place = ({ canvas, label }: { canvas: HTMLCanvasElement; label: string }) => {
      canvas.className = 'block h-auto w-full';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', label);
      if (node.firstChild !== canvas) node.replaceChildren(canvas);
    };
    place(shown);
    return {
      update: place,
      // The slot unmounts with the page or the viewer; the canvas itself is freed by its owner.
      destroy: () => node.replaceChildren(),
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

  /**
   * Drag-to-pan for a MOUSE, at any zoom that overflows the viewport.
   *
   * A finger already pans: the pages live in a real scroll container and `touch-pan-x touch-pan-y`
   * leaves one-finger scrolling to the browser. A mouse had nothing - the scrollbars and the wheel
   * were the only way to move, and at x3 a page is wider than the window, so reading a line meant
   * hunting for the horizontal scrollbar. This moves the container's own scroll rather than any
   * transform, so it composes with the zoom instead of competing with it.
   *
   * IT MUST NOT STEAL A TEXT SELECTION. `PdfTextLayer` is `pointer-events: none` with `auto` on the
   * spans exactly so the gaps stay available to handlers here, which makes the target the honest
   * test: down on a span is a selection, down anywhere else is a pan.
   */
  let isPanning = $state(false);
  let panStartX = 0;
  let panStartY = 0;
  let panStartScrollLeft = 0;
  let panStartScrollTop = 0;

  const canPan = $derived(zoom > ZOOM_STEPS[0]);

  function handlePointerDown(e: PointerEvent) {
    if (e.pointerType === 'touch' || e.button !== 0 || !scrollEl || !canPan) return;
    if ((e.target as HTMLElement).closest('.pdf-text-layer, button, a')) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartScrollLeft = scrollEl.scrollLeft;
    panStartScrollTop = scrollEl.scrollTop;
    scrollEl.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    if (!isPanning || !scrollEl) return;
    // Dragging right must bring content from the left, so the scroll moves AGAINST the pointer.
    scrollEl.scrollLeft = panStartScrollLeft - (e.clientX - panStartX);
    scrollEl.scrollTop = panStartScrollTop - (e.clientY - panStartY);
  }

  function handlePointerUp(e: PointerEvent) {
    if (!isPanning) return;
    isPanning = false;
    scrollEl?.releasePointerCapture(e.pointerId);
  }
</script>

<FullScreenViewer ariaLabel={fileName} {onClose} maxWidthClass="sm:max-w-275">
  {#snippet headerLead()}
    <FileText size={16} strokeWidth={2.5} class="shrink-0 opacity-70" />
    <p class="min-w-0 flex-1 truncate text-xs opacity-80 sm:text-sm">{fileName}</p>
    {#if pageCount > 0}
      <span class="text-2xs shrink-0 tabular-nums opacity-50">
        {m.pdf_viewer_page_count({ count: pageCount })}
      </span>
    {/if}
  {/snippet}

  {#snippet headerActions()}
    <button
      type="button"
      class="ui-icon-button rounded-lg bg-white/15 transition-colors hover:bg-white/25 disabled:opacity-30"
      disabled={zoomIndex === 0}
      onclick={() => (zoomIndex = Math.max(0, zoomIndex - 1))}
      aria-label={m.pdf_viewer_zoom_out()}
    >
      <ZoomOut size={18} strokeWidth={2.5} />
    </button>
    <button
      type="button"
      class="ui-icon-button rounded-lg bg-white/15 transition-colors hover:bg-white/25 disabled:opacity-30"
      disabled={zoomIndex === ZOOM_STEPS.length - 1}
      onclick={() => (zoomIndex = Math.min(ZOOM_STEPS.length - 1, zoomIndex + 1))}
      aria-label={m.pdf_viewer_zoom_in()}
    >
      <ZoomIn size={18} strokeWidth={2.5} />
    </button>
    {#if onDownload}
      <button
        type="button"
        class="ui-icon-button rounded-lg bg-white/15 transition-colors hover:bg-white/25"
        onclick={onDownload}
        aria-label={m.common_download_label()}
        title={m.common_download_label()}
      >
        <Download size={18} strokeWidth={2.5} />
      </button>
    {/if}
  {/snippet}

  <!-- Pages -->
  <!-- `document` rather than a bare div: the pages ARE the document being read, and the pinch
       handlers below need the element to carry a role. -->
  <div
    role="document"
    class="min-h-0 flex-1 touch-pan-x touch-pan-y overflow-auto overscroll-contain px-2 py-3 sm:px-4"
    class:cursor-grab={canPan && !isPanning}
    class:cursor-grabbing={isPanning}
    bind:this={scrollEl}
    bind:clientWidth={viewportWidth}
    ontouchstart={handleTouchStart}
    ontouchmove={handleTouchMove}
    ontouchend={handleTouchEnd}
    ontouchcancel={handleTouchEnd}
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={handlePointerUp}
    onpointercancel={handlePointerUp}
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
        bind:clientWidth={columnInnerWidth}
        class="mx-auto flex flex-col items-center gap-3"
        style="width: {zoom * 100}%; max-width: {COLUMN_MAX_WIDTH * zoom}px;
               transform: scale({pinchScale});
               transform-origin: {pinchOriginCss};
               transition: {pinchScale === 1 && !settling ? 'transform 120ms ease-out' : 'none'};"
      >
        {#each { length: pageCount } as _, index (index)}
          {@const shown = sharp[index] ?? previews[index]}
          <!-- `relative` so the text layer can be absolutely placed over the bitmap. -->
          <div
            use:observePage={index}
            class="relative w-full overflow-hidden rounded-lg bg-white shadow-lg"
            style={shown ? '' : `aspect-ratio: 1 / ${placeholderRatio(index)};`}
          >
            {#if shown}
              <div
                use:showCanvas={{
                  canvas: shown.canvas,
                  label: m.pdf_viewer_page_alt({ page: index + 1, total: pageCount }),
                }}
              ></div>
              <!--
                The page's own displayed height, derived rather than measured: every page is
                the column's inner width wide, and the bitmap's aspect ratio gives the rest.
                Measuring instead would mean one ResizeObserver per page - two hundred of them
                on a long document - to learn something the numbers already say exactly.
              -->
              {#if pageTexts[index] && near[index] && columnInnerWidth > 0}
                <PdfTextLayer
                  runs={pageTexts[index]!}
                  pageWidth={columnInnerWidth}
                  pageHeight={(columnInnerWidth * shown.height) / shown.width}
                />
              {/if}
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</FullScreenViewer>
