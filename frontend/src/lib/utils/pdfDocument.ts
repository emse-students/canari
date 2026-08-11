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

/** Upper bound on the render scale, so a poster-sized page cannot blow up memory. */
export const MAX_PDF_RENDER_SCALE = 4;

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

/** One rasterised page. */
export interface RenderedPdfPage {
  /** Object URL of the PNG; the caller MUST release it with {@link releasePdfObjectUrl}. */
  url: string;
  /** Bitmap width in pixels. */
  width: number;
  /** Bitmap height in pixels - what a caller needs to reserve the page's real proportions. */
  height: number;
}

/** One run of text, placed in fractions of the page box so it survives every re-rasterisation. */
export interface PdfTextRun extends TextRunBox {
  /** The characters themselves. */
  text: string;
}

/** An open PDF the caller MUST {@link PdfDocument.destroy} when it is done with it. */
export interface PdfDocument {
  /** Total page count, 1-based page numbers. */
  readonly numPages: number;
  /** Rasterises one page to a PNG. */
  renderPage(pageNumber: number, maxWidth: number): Promise<RenderedPdfPage>;
  /**
   * Text runs of one page, for the selectable layer drawn over its bitmap.
   *
   * Separate from {@link renderPage} rather than returned with it, because the two have different
   * lifetimes: a page is re-rasterised on every zoom step and its text never changes, so folding
   * them together would re-extract the text three times for nothing. It is also the cheap half -
   * no canvas, no PNG encode - which is what makes it affordable to have for a page that is merely
   * on screen.
   */
  getPageText(pageNumber: number): Promise<PdfTextRun[]>;
  /** Tears the worker down. Safe to call twice. */
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
  const task = lib.getDocument({ url: source, disableAutoFetch: true, disableStream: true });
  const doc = await task.promise;
  let destroyed = false;

  return {
    numPages: doc.numPages,

    async renderPage(pageNumber: number, maxWidth: number): Promise<RenderedPdfPage> {
      if (destroyed) throw new Error('PDF document already destroyed');
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const dpr = typeof window === 'undefined' ? 1 : (window.devicePixelRatio ?? 1);
      const scale = Math.min((maxWidth * dpr) / base.width, MAX_PDF_RENDER_SCALE);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));
      canvas.width = width;
      canvas.height = height;

      await page.render({ canvas, viewport }).promise;

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      // Release the backing store immediately: on a long document these add up.
      canvas.width = 0;
      canvas.height = 0;

      if (!blob) throw new Error(`Canvas produced no bitmap for page ${pageNumber}`);
      return { url: URL.createObjectURL(blob), width, height };
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
        if (!('str' in item) || typeof item.str !== 'string' || item.str.length === 0) continue;
        const pageMatrix = asMatrix(viewport.transform);
        const runMatrix = asMatrix(item.transform);
        if (!pageMatrix || !runMatrix) continue;
        const box = textRunBox(pageMatrix, runMatrix, item.width, viewport.width, viewport.height);
        // A run with no placeable box is DROPPED rather than placed at the origin: a pile of
        // spans in the top-left corner would be selectable text that belongs nowhere, which is
        // worse than text that is merely absent.
        if (box) runs.push({ text: item.str, ...box });
      }
      return runs;
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      // Destroying the LOADING TASK is what tears the worker down; the document proxy has
      // no destroy of its own.
      await task.destroy();
    },
  };
}

/** Revokes an object URL from a {@link RenderedPdfPage}. */
export function releasePdfObjectUrl(url: string | null): void {
  if (url) URL.revokeObjectURL(url);
}
