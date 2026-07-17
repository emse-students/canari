import { rasterizeElementToCanvas } from '$lib/utils/pdfRaster';

/**
 * Rasterises the live poster canvas element and saves it as a single-page PDF (no print dialog /
 * new tab).
 *
 * The passed element IS the on-screen poster - a fixed A2-landscape frame (STAGE_WIDTH x
 * STAGE_HEIGHT, ratio SQRT2), so the export never diverges from the preview (the whole point of the
 * snapdom pipeline). Because the content is already A2-ratio, it fills a STANDARD A2 landscape page
 * with a single {@link addImage}: no distortion, no white bar, and it prints borderless on real A2.
 *
 * @param el - The attached, natural-size poster element to capture.
 * @param filename - Base filename (sanitised; ".pdf" appended).
 */
export async function exportPosterPdf(el: HTMLElement, filename: string): Promise<void> {
  const { default: jsPDF } = await import('jspdf');

  const canvas = await rasterizeElementToCanvas(el, {
    scale: 2,
    // The app's *Variable* families, so the real Canari fonts are embedded (not a fallback).
    fonts: [
      "700 40px 'Fredoka Variable'",
      "800 20px 'Fredoka Variable'",
      "700 14px 'Nunito Variable'",
    ],
  });

  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a2' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const imgData = canvas.toDataURL('image/jpeg', 0.92);
  pdf.addImage(imgData, 'JPEG', 0, 0, pageW, pageH);

  const safe = filename.replace(/[^a-zA-Z0-9À-ž\- ]/g, '_').trim() || 'carte-vie-asso';
  pdf.save(`${safe}.pdf`);
}
