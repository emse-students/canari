/**
 * First-page thumbnails for PDF attachments.
 *
 * The rendering itself - and the reasoning behind rasterising rather than embedding - lives
 * in `pdfDocument.ts`, which the full-document viewer shares. This module is only the
 * "identify a PDF attachment, show its cover" half.
 */

import { canvasToBlob } from './canvasBlob';
import { openPdfDocument, releasePdfCanvas } from './pdfDocument';

/** Canonical PDF mime type. */
export const PDF_MIME_TYPE = 'application/pdf';

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

/**
 * Encoding of a thumbnail - WebP, which is small, and which every engine either encodes or answers
 * with a PNG instead. Encoded through `canvasToBlob` (synchronous `toDataURL`), never `toBlob`: on
 * the Android WebView `toBlob` waits for an idle slot that a chat which is loading or scrolling does
 * not grant, and a 109 x 154 thumbnail took 4.0 s to appear on a Mi 9T (2026-10-11).
 */
export const PDF_THUMBNAIL_TYPE = 'image/webp';

/**
 * Renders page 1 of a PDF and returns an object URL for it.
 *
 * @param source - URL of the decrypted PDF (an object URL, in practice).
 * @param maxWidth - CSS width the thumbnail is displayed at; the bitmap is
 *   rendered at the device pixel ratio so it stays sharp on a phone.
 * @returns An object URL the caller MUST release with {@link releasePdfThumbnail}.
 */
export async function renderPdfFirstPage(source: string, maxWidth: number): Promise<string> {
  const doc = await openPdfDocument(source);
  try {
    const { canvas } = await doc.renderPage(1, { cssWidth: maxWidth }).promise;
    try {
      const blob = canvasToBlob(canvas, PDF_THUMBNAIL_TYPE, 0.85);
      if (!blob) throw new Error('Canvas produced no bitmap for the PDF thumbnail');
      return URL.createObjectURL(blob);
    } finally {
      releasePdfCanvas(canvas);
    }
  } finally {
    await doc.destroy();
  }
}

/** Revokes a thumbnail object URL returned by {@link renderPdfFirstPage}. */
export function releasePdfThumbnail(url: string | null): void {
  if (url) URL.revokeObjectURL(url);
}
