/**
 * First-page thumbnails for PDF attachments, rendered in the browser.
 *
 * Server-side thumbnailing is impossible here by design: chat and post media are
 * encrypted client-side with a per-file CEK, so the backend only ever holds an
 * opaque blob and cannot open the document. Embedding the PDF in an `<iframe>`
 * is not portable either - Android's WebView has no PDF renderer - so the page
 * is rasterised with pdf.js onto a canvas, which behaves identically everywhere.
 *
 * pdf.js and its worker are loaded through a dynamic import so neither enters
 * the main bundle: nothing is fetched until a PDF is actually displayed.
 */

/** Canonical PDF mime type. */
export const PDF_MIME_TYPE = 'application/pdf';

/** Upper bound on the rendered bitmap, so a poster-sized page cannot blow up memory. */
const MAX_THUMBNAIL_SCALE = 4;

/**
 * Whether an attachment should be previewed as a PDF. The mime type is
 * authoritative; the extension is only consulted when the mime type is missing
 * or generic, which is what uploads from some mobile pickers produce.
 */
export function isPdfAttachment(mimeType?: string, fileName?: string): boolean {
  if (mimeType?.toLowerCase().startsWith(PDF_MIME_TYPE)) return true;
  const generic = !mimeType || mimeType === 'application/octet-stream';
  return generic && !!fileName?.toLowerCase().endsWith('.pdf');
}

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

/**
 * Renders page 1 of a PDF to a PNG and returns an object URL for it.
 *
 * @param source - URL of the decrypted PDF (an object URL, in practice).
 * @param maxWidth - CSS width the thumbnail is displayed at; the bitmap is
 *   rendered at the device pixel ratio so it stays sharp on a phone.
 * @returns An object URL the caller MUST release with {@link releasePdfThumbnail}.
 */
export async function renderPdfFirstPage(source: string, maxWidth: number): Promise<string> {
  const lib = await loadPdfjs();

  // These documents come from other users. pdf.js 6 no longer has the
  // `eval`-based font-compilation path that older versions needed to be told to
  // turn off, so there is nothing left to opt out of here.
  const task = lib.getDocument({
    url: source,
    disableAutoFetch: true,
    disableStream: true,
  });

  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const dpr = typeof window === 'undefined' ? 1 : (window.devicePixelRatio ?? 1);
    const scale = Math.min((maxWidth * dpr) / base.width, MAX_THUMBNAIL_SCALE);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));

    await page.render({ canvas, viewport }).promise;

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    // Release the backing store immediately: on a long feed these add up.
    canvas.width = 0;
    canvas.height = 0;

    if (!blob) throw new Error('Canvas produced no thumbnail bitmap');
    return URL.createObjectURL(blob);
  } finally {
    // Destroying the LOADING TASK is what tears the worker down; the document
    // proxy has no destroy of its own.
    await task.destroy();
  }
}

/** Revokes a thumbnail object URL returned by {@link renderPdfFirstPage}. */
export function releasePdfThumbnail(url: string | null): void {
  if (url) URL.revokeObjectURL(url);
}
