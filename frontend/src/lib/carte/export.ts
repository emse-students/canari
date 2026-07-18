import { exportSearchablePdf } from '$lib/pdf/searchableRaster';
import { STAGE_WIDTH, STAGE_HEIGHT } from './layout';

/**
 * Exports the live poster element as a large, searchable A0-landscape PDF.
 *
 * The passed element IS the on-screen poster - a fixed A2-ratio frame (STAGE_WIDTH x STAGE_HEIGHT,
 * ratio SQRT2, identical to A0's ratio). It is rendered via the shared "searchable raster" pipeline:
 * a pixel-faithful background (shapes, photos, logos) with every `data-pdf-text` run re-drawn as real
 * vector text on top - so the export matches the preview, prints crisp on A0, and its text stays
 * selectable / Ctrl-F-searchable. Because the content is already A0-ratio it fills the page with no
 * distortion and no white bar.
 *
 * @param el - The attached, natural-size poster element to capture.
 * @param filename - Base filename (sanitised; ".pdf" appended).
 */
export async function exportPosterPdf(el: HTMLElement, filename: string): Promise<void> {
  await exportSearchablePdf(el, {
    filename,
    format: 'a0',
    orientation: 'landscape',
    naturalWidth: STAGE_WIDTH,
    naturalHeight: STAGE_HEIGHT,
    // The app's *Variable* families, so the raster background embeds the real Canari fonts.
    fonts: [
      "700 40px 'Fredoka Variable'",
      "800 20px 'Fredoka Variable'",
      "700 14px 'Nunito Variable'",
    ],
  });
}
