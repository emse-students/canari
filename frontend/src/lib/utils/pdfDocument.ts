/**
 * Shared pdf.js access: load the library once, open a decrypted PDF, rasterise any page.
 *
 * Rasterising rather than embedding is not a preference, it is the only portable option.
 * Chat and post media are encrypted client-side with a per-file CEK, so the backend only
 * holds an opaque blob and can never thumbnail or serve a viewer of its own; and an
 * `<iframe>` over the decrypted object URL is blank on Android, whose WebView ships no PDF
 * renderer. A canvas behaves identically on every surface - browser, Android WebView, iOS
 * WKWebView, desktop - which is what lets one viewer component serve all of them.
 *
 * pdf.js and its worker load through a dynamic import so neither enters the main bundle:
 * nothing is fetched until a PDF is actually displayed.
 */

import { asMatrix, textRunBox, type TextRunBox } from './pdfTextGeometry';
import { renderScale } from './pdfRenderQueue';
import { Log } from './Log';

type PdfjsModule = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/** Loads pdf.js once per session and points it at its bundled worker. */
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const lib = await import('pdfjs-dist');
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      return lib;
    })().catch((err) => {
      // Do not cache a failed load: a transient chunk fetch must be retryable.
      pdfjsPromise = null;
      throw err;
    });
  }
  return pdfjsPromise;
}

type PdfjsWorker = InstanceType<PdfjsModule['PDFWorker']>;

let sharedWorker: PdfjsWorker | null = null;

/**
 * The ONE pdf.js worker every open document runs on, created on the first document.
 *
 * Left to itself, `getDocument` creates a worker per loading task and terminates it in
 * `destroy()`, so every thumbnail and every reader open started a module worker of its own: a
 * fetch of the 1 MB worker script (from cache), its parse and its start-up, for a cover rendered in
 * ~55-80 ms. The 2026-10-12 console audit counted 36 such loads in 3 min for two PDFs on screen
 * ([web-console-log-audit](../../../../docs/wiki/frontend/web-console-log-audit-2026-10-12.md)).
 * A worker handed in through `worker` is not the task's to destroy - pdf.js only tears down the one
 * it created (`PDFDocumentLoadingTask.destroy`, `this._worker`) - so the document's own state is
 * freed on `destroy()` and the worker stays for the next one.
 *
 * A worker whose start-up FAILED is not kept, for the same reason a failed library load is not:
 * the next document must be able to try again.
 */
function sharedPdfWorker(lib: PdfjsModule): PdfjsWorker {
  if (sharedWorker) return sharedWorker;
  const worker = new lib.PDFWorker();
  sharedWorker = worker;
  Log.d('pdfDocument:workerCreated');
  worker.promise.catch((err: unknown) => {
    Log.d('pdfDocument:workerFailed', { err });
    if (sharedWorker === worker) sharedWorker = null;
  });
  return worker;
}

/**
 * The rejection of a render that was cancelled - a TYPE, so a caller tells "nobody wants this page
 * any more" from a real failure without reading a message.
 */
export class PdfRenderCancelled extends Error {
  constructor(pageNumber: number) {
    super(`PDF page ${pageNumber} render cancelled`);
    this.name = 'PdfRenderCancelled';
  }
}

/**
 * One page rasterised into a DETACHED canvas, which the caller inserts into the page as it is.
 *
 * A canvas rather than an encoded image, and that is the fix of 2026-10-11. The reader used to
 * `toBlob` every page to a PNG and show it in an `<img>`. Chromium encodes PNG and JPEG for
 * `toBlob` only when the main thread is IDLE, and a reader who is scrolling or pinching leaves it
 * none: measured on a Mi 9T, the same `toBlob` took 150-350 ms on a quiet page and 4.07 s while
 * the reader scrolled - for a 1040 x 1470 page and a 109 x 154 thumbnail alike - when the render
 * itself took 55-83 ms. Showing the canvas skips the encode and the decode, and holds the page's
 * pixels once instead of three times (canvas, PNG, decoded image).
 */
export interface RenderedPdfCanvas {
  /** The rasterised page; free it with {@link releasePdfCanvas} once it is no longer shown. */
  canvas: HTMLCanvasElement;
  /** Bitmap width in device pixels. */
  width: number;
  /** Bitmap height in device pixels - what a caller needs to reserve the page's real proportions. */
  height: number;
}

/** A render in flight: its result, and the way to stop it. */
export interface PdfRenderHandle {
  /** Resolves with the page, or rejects with {@link PdfRenderCancelled} once cancelled. */
  promise: Promise<RenderedPdfCanvas>;
  /** Stops the render (pdf.js `RenderTask.cancel`) and frees its canvas. Safe to call twice. */
  cancel(): void;
}

/** Sizing of one render. */
export interface PdfRenderSize {
  /** CSS width the page is displayed at; the bitmap targets it at the device pixel ratio. */
  cssWidth: number;
  /** Pixel cap for this bitmap, defaulting to `PAGE_PIXEL_BUDGET` in `pdfRenderQueue.ts`. */
  maxPixels?: number;
}

/** Frees a canvas's backing store now rather than whenever the collector gets to it. */
export function releasePdfCanvas(canvas: HTMLCanvasElement | null | undefined): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/** One run of text, placed in fractions of the page box so it survives every re-rasterisation. */
export interface PdfTextRun extends TextRunBox {
  /** The characters themselves. */
  text: string;
  /**
   * The line ends after this run. The layer puts a `<br>` there, as pdf.js's own viewer does:
   * absolutely placed spans carry no line structure, so a copy joined the last word of a line to
   * the first of the next ("lesautres", Mi 9T, 2026-10-12).
   */
  eol: boolean;
}

/** An open PDF the caller MUST {@link PdfDocument.destroy} when it is done with it. */
export interface PdfDocument {
  /** Total page count, 1-based page numbers. */
  readonly numPages: number;
  /** Starts rasterising one page into a fresh canvas. */
  renderPage(pageNumber: number, size: PdfRenderSize): PdfRenderHandle;
  /**
   * Drops pdf.js's caches for one page - chiefly its DECODED images, which for a scanned page are
   * the full picture (1240 x 1754 RGBA is 8.7 MB) and used to be kept for every page ever shown.
   * The next render of that page decodes again. pdf.js refuses while the page renders; that is
   * logged and harmless, since the page is wanted again anyway.
   */
  releasePage(pageNumber: number): void;
  /**
   * Text runs of one page, for the selectable layer drawn over its bitmap.
   *
   * Separate from {@link renderPage} rather than returned with it, because the two have different
   * lifetimes: a page is re-rasterised on every zoom step and its text never changes, so folding
   * them together would re-extract the text for nothing. It is also the cheap half - no canvas -
   * which is what makes it affordable to have for a page that is merely on screen.
   */
  getPageText(pageNumber: number): Promise<PdfTextRun[]>;
  /** Frees the document in the shared worker; the worker itself stays. Safe to call twice. */
  destroy(): Promise<void>;
}

/**
 * Opens a decrypted PDF for rendering.
 *
 * @param source - URL of the decrypted PDF (an object URL, in practice).
 */
export async function openPdfDocument(source: string): Promise<PdfDocument> {
  const lib = await loadPdfjs();

  // These documents come from other users. pdf.js 6 no longer has the `eval`-based
  // font-compilation path that older versions needed to be told to turn off, so there is
  // nothing left to opt out of here.
  //
  // Range requests and streaming would buy nothing: the source is a blob already decrypted in
  // memory, read whole in ~60 ms for 13 MB on a Mi 9T, and the document opens in ~220 ms.
  const task = lib.getDocument({
    url: source,
    disableAutoFetch: true,
    disableStream: true,
    worker: sharedPdfWorker(lib),
  });
  const doc = await task.promise;
  let destroyed = false;

  return {
    numPages: doc.numPages,

    renderPage(pageNumber: number, size: PdfRenderSize): PdfRenderHandle {
      let cancelled = false;
      let renderTask: { cancel(): void } | null = null;
      const canvas = document.createElement('canvas');

      const promise = (async (): Promise<RenderedPdfCanvas> => {
        if (destroyed) throw new Error('PDF document already destroyed');
        const page = await doc.getPage(pageNumber);
        if (cancelled) throw new PdfRenderCancelled(pageNumber);
        const base = page.getViewport({ scale: 1 });
        const dpr = typeof window === 'undefined' ? 1 : (window.devicePixelRatio ?? 1);
        const scale = renderScale(base.width, base.height, size.cssWidth, dpr, size.maxPixels);
        const viewport = page.getViewport({ scale });
        const width = Math.max(1, Math.ceil(viewport.width));
        const height = Math.max(1, Math.ceil(viewport.height));
        canvas.width = width;
        canvas.height = height;

        const running = page.render({ canvas, viewport });
        renderTask = running;
        try {
          await running.promise;
        } catch (err) {
          releasePdfCanvas(canvas);
          if (cancelled || err instanceof lib.RenderingCancelledException) {
            throw new PdfRenderCancelled(pageNumber);
          }
          throw err;
        }
        if (cancelled) {
          releasePdfCanvas(canvas);
          throw new PdfRenderCancelled(pageNumber);
        }
        return { canvas, width, height };
      })();

      return {
        promise,
        cancel: () => {
          if (cancelled) return;
          cancelled = true;
          renderTask?.cancel();
        },
      };
    },

    releasePage(pageNumber: number): void {
      if (destroyed) return;
      // `getPage` on a page already loaded resolves from pdf.js's own cache; it never parses a
      // page only to clean it.
      void doc
        .getPage(pageNumber)
        .then((page) => {
          if (!page.cleanup()) Log.d('pdfDocument:cleanupRefused', { page: pageNumber });
        })
        .catch((err) => Log.d('pdfDocument:cleanupFailed', { page: pageNumber, err }));
    },

    async getPageText(pageNumber: number): Promise<PdfTextRun[]> {
      if (destroyed) throw new Error('PDF document already destroyed');
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const runs: PdfTextRun[] = [];
      for (const item of content.items) {
        // `getTextContent` yields marked-content markers alongside the text items; only the
        // latter carry a transform, and `str` is what distinguishes them.
        if (!('str' in item) || typeof item.str !== 'string') continue;
        // An EMPTY item can still end a line (3 of 230 on a page of the OCR scan the defect was
        // read on); it places nothing, so its line end goes to the run before it.
        if (item.str.length === 0) {
          if (item.hasEOL && runs.length > 0) runs[runs.length - 1].eol = true;
          continue;
        }
        const pageMatrix = asMatrix(viewport.transform);
        const runMatrix = asMatrix(item.transform);
        if (!pageMatrix || !runMatrix) continue;
        const box = textRunBox(pageMatrix, runMatrix, item.width, viewport.width, viewport.height);
        // A run with no placeable box is DROPPED rather than placed at the origin: a pile of
        // spans in the top-left corner would be selectable text that belongs nowhere, which is
        // worse than text that is merely absent.
        if (box) runs.push({ text: item.str, eol: item.hasEOL === true, ...box });
      }
      return runs;
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      // Destroying the LOADING TASK is what frees the document in the worker; the document proxy
      // has no destroy of its own. The shared worker is not the task's, so it survives this.
      await task.destroy();
    },
  };
}
