/**
 * Shared "searchable raster" PDF exporter for the client-side poster/agenda exports.
 *
 * Strategy (chosen so the export keeps the EXACT on-screen look while staying crisp + searchable):
 * the element's visuals (shapes, photos, logos, background) are rasterised once as a high-resolution
 * page background, but every text node marked `data-pdf-text` is rendered TRANSPARENT for that raster
 * pass and then re-drawn on top as REAL vector text. The result is a PDF whose text is sharp at any
 * zoom and selectable / Ctrl-F-searchable, over a pixel-faithful background - with no double text.
 *
 * The caller owns nothing but the element: this reads the live DOM boxes, so wrapping and any
 * auto-shrink already applied on screen are reproduced for free. Overlay text uses the app's real
 * embedded fonts (see {@link registerAppFonts}), so it matches the on-screen typography exactly.
 */
import { rasterizeElementToCanvas, type RasterizeOptions } from '$lib/utils/pdfRaster';
import { registerAppFonts, pickAppFont } from './appFonts';

/** One measured text run to re-draw as vector text over the raster. */
interface TextSpec {
  el: HTMLElement;
  /** Box, in the element's natural (unscaled) coordinate space. */
  x: number;
  y: number;
  w: number;
  fontPx: number;
  align: 'left' | 'center' | 'right';
  /** The run's font-family stack + numeric weight, used to pick the matching embedded app font. */
  family: string;
  weight: number;
  color: { r: number; g: number; b: number };
  text: string;
}

/** Parses a CSS `rgb()/rgba()` color into 0-255 components (defaults to black on parse failure). */
function parseRgb(css: string): { r: number; g: number; b: number } {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) return { r: 0, g: 0, b: 0 };
  const [r, g, b] = m[1].split(',').map((p) => parseInt(p.trim(), 10));
  return { r: r || 0, g: g || 0, b: b || 0 };
}

/** Reads every `[data-pdf-text]` run under `root`, converted into the root's natural coordinate space. */
function collectTextSpecs(root: HTMLElement, naturalWidth: number): TextSpec[] {
  const rootRect = root.getBoundingClientRect();
  // The element may be rendered under a CSS transform (preview zoom); k maps client px -> natural px.
  const k = rootRect.width > 0 ? naturalWidth / rootRect.width : 1;
  const specs: TextSpec[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-pdf-text]')) {
    const text = (el.textContent ?? '').trim();
    if (!text) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const rawAlign = cs.textAlign;
    const align = rawAlign === 'center' ? 'center' : rawAlign === 'right' ? 'right' : 'left';
    const parsedWeight = parseInt(cs.fontWeight, 10);
    const weight = Number.isFinite(parsedWeight)
      ? parsedWeight
      : cs.fontWeight === 'bold'
        ? 700
        : 400;
    specs.push({
      el,
      x: (r.left - rootRect.left) * k,
      y: (r.top - rootRect.top) * k,
      w: r.width * k,
      // NB: font-size is a layout value, NOT scaled by an ancestor CSS transform (unlike the rects
      // above), so it is already in natural px - multiplying by k here would wrongly inflate it.
      fontPx: parseFloat(cs.fontSize),
      align,
      family: cs.fontFamily,
      weight,
      color: parseRgb(cs.color),
      text,
    });
  }
  return specs;
}

/** Options for {@link exportSearchablePdf}. */
export interface SearchablePdfOptions {
  /** Base filename (sanitised; ".pdf" appended). */
  filename: string;
  /** jsPDF page format (e.g. `'a0'`) or explicit `[w, h]` in mm. */
  format: string | [number, number];
  orientation: 'landscape' | 'portrait';
  /** The element's intrinsic (un-transformed) pixel size, used to map DOM boxes -> mm. */
  naturalWidth: number;
  naturalHeight: number;
  /** snapdom scale for the background raster (higher = crisper shapes/photos). Default 3. */
  rasterScale?: number;
  /** Background-raster JPEG quality (0-1). Default 0.9. */
  jpegQuality?: number;
  /** Fonts to force-load before the raster (see {@link RasterizeOptions.fonts}). */
  fonts?: string[];
}

/** 1 typographic point in millimetres (72pt = 1in = 25.4mm). */
const PT_PER_MM = 1 / (25.4 / 72);

/**
 * Exports `el` as a "searchable raster" PDF: a pixel-faithful background with real, selectable vector
 * text drawn on top (see the module docstring). Returns once the file has been saved.
 */
export async function exportSearchablePdf(
  el: HTMLElement,
  opts: SearchablePdfOptions
): Promise<void> {
  const { default: jsPDF } = await import('jspdf');

  // 1. Measure the text runs while they are still visible (so colors/sizes are the real ones).
  const specs = collectTextSpecs(el, opts.naturalWidth);

  // 2. Hide the text for the background raster (keep layout, so boxes are unchanged), snapshotting
  //    the inline color/shadow so they can be restored verbatim afterwards.
  const restore = specs.map((s) => ({
    el: s.el,
    color: s.el.style.color,
    shadow: s.el.style.textShadow,
  }));
  for (const s of specs) {
    s.el.style.setProperty('color', 'transparent', 'important');
    s.el.style.setProperty('text-shadow', 'none', 'important');
  }

  let canvas: HTMLCanvasElement;
  try {
    const rasterOpts: RasterizeOptions = { scale: opts.rasterScale ?? 3, fonts: opts.fonts };
    canvas = await rasterizeElementToCanvas(el, rasterOpts);
  } finally {
    // 3. Always restore the visible text, even if the raster failed.
    for (const r of restore) {
      r.el.style.color = r.color;
      r.el.style.textShadow = r.shadow;
    }
  }

  // 4. Compose the PDF: full-bleed background image, then the vector text on top.
  const pdf = new jsPDF({ orientation: opts.orientation, unit: 'mm', format: opts.format });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  pdf.addImage(canvas.toDataURL('image/jpeg', opts.jpegQuality ?? 0.9), 'JPEG', 0, 0, pageW, pageH);

  // Embed the real app fonts so the overlay text matches the on-screen typography exactly.
  await registerAppFonts(pdf);

  const mmPerPx = pageW / opts.naturalWidth;
  for (const s of specs) {
    const font = pickAppFont(s.family, s.weight);
    if (font) pdf.setFont(font.name, font.style);
    else pdf.setFont('helvetica', s.weight >= 600 ? 'bold' : 'normal');
    pdf.setFontSize(s.fontPx * mmPerPx * PT_PER_MM);
    pdf.setTextColor(s.color.r, s.color.g, s.color.b);
    const boxW = s.w * mmPerPx;
    const lines = pdf.splitTextToSize(s.text, boxW);
    const anchorX = s.align === 'center' ? s.x + s.w / 2 : s.align === 'right' ? s.x + s.w : s.x;
    pdf.text(lines, anchorX * mmPerPx, s.y * mmPerPx, {
      align: s.align,
      baseline: 'top',
      lineHeightFactor: 1.15,
    });
  }

  const safe = opts.filename.replace(/[^a-zA-Z0-9À-ž\- ]/g, '_').trim() || 'export';
  pdf.save(`${safe}.pdf`);
}
