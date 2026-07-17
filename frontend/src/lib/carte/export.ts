import { rasterizeElementToCanvas } from '$lib/utils/pdfRaster';

/**
 * Rasterises the live poster canvas element and saves it as a PDF (no print dialog / new tab).
 *
 * The passed element IS the on-screen poster (fixed pixel size), so the export never diverges
 * from the preview - the whole point of the snapdom pipeline. Orientation follows the element's
 * aspect ratio; a taller-than-page render is split across pages.
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

  const landscape = canvas.width >= canvas.height;
  const pdf = new jsPDF({
    orientation: landscape ? 'landscape' : 'portrait',
    unit: 'mm',
    format: 'a4',
  });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const imgData = canvas.toDataURL('image/jpeg', 0.92);
  const imgH = (canvas.height * pageW) / canvas.width;

  if (imgH <= pageH) {
    pdf.addImage(imgData, 'JPEG', 0, 0, pageW, imgH);
  } else {
    let yMm = 0;
    while (yMm < imgH) {
      if (yMm > 0) pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, -yMm, pageW, imgH);
      yMm += pageH;
    }
  }

  const safe = filename.replace(/[^a-zA-Z0-9À-ž\- ]/g, '_').trim() || 'carte-vie-asso';
  pdf.save(`${safe}.pdf`);
}
