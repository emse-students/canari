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
  h: number;
  fontPx: number;
  align: 'left' | 'center' | 'right';
  /** The run's font-family stack + numeric weight, used to pick the matching embedded app font. */
  family: string;
  weight: number;
  color: { r: number; g: number; b: number };
  lineHeightPx: number;
  letterSpacingPx: number;
  text: string;
}

/** Parses a CSS `rgb()/rgba()` color into 0-255 components (defaults to black on parse failure). */
function parseRgb(css: string): { r: number; g: number; b: number } {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) return { r: 0, g: 0, b: 0 };
  const [r, g, b] = m[1].split(',').map((p) => parseInt(p.trim(), 10));
  return { r: r || 0, g: g || 0, b: b || 0 };
}

/**
 * Walks up the DOM from `el` to `root` (exclusive) and accumulates the visual scale
 * applied by CSS `transform`. This maps a layout size (like font-size) into the
 * natural coordinate space of the root element.
 */
function getAccumulatedScale(el: HTMLElement, root: HTMLElement): number {
  let scale = 1;
  let current: HTMLElement | null = el;
  while (current && current !== root) {
    const transform = getComputedStyle(current).transform;
    if (transform && transform !== 'none') {
      const match = transform.match(/^matrix(?:3d)?\((.+)\)$/);
      if (match) {
        const values = match[1].split(',').map(parseFloat);
        // scaleX is the length of the first column vector (m11, m12)
        const scaleX = Math.sqrt(values[0] * values[0] + values[1] * values[1]);
        if (scaleX > 0) scale *= scaleX;
      }
    }
    current = current.parentElement;
  }
  return scale;
}

/** Reads every `[data-pdf-text]` run under `root`, converted into the root's natural coordinate space. */
function collectTextSpecs(root: HTMLElement, naturalWidth: number): TextSpec[] {
  const rootRect = root.getBoundingClientRect();
  // The element may be rendered under a CSS transform (preview zoom); k maps client px -> natural px.
  const k = rootRect.width > 0 ? naturalWidth / rootRect.width : 1;
  const specs: TextSpec[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-pdf-text]')) {
    let text = (el.textContent ?? '').trim();
    if (!text) continue;
    const cs = getComputedStyle(el);
    if (cs.textTransform === 'uppercase') {
      text = text.toUpperCase();
    } else if (cs.textTransform === 'lowercase') {
      text = text.toLowerCase();
    }
    const r = el.getBoundingClientRect();
    const rawAlign = cs.textAlign;
    const align = rawAlign === 'center' ? 'center' : rawAlign === 'right' ? 'right' : 'left';
    const parsedWeight = parseInt(cs.fontWeight, 10);
    const weight = Number.isFinite(parsedWeight)
      ? parsedWeight
      : cs.fontWeight === 'bold'
        ? 700
        : 400;
    const localScale = getAccumulatedScale(el, root);
    const fontPx = parseFloat(cs.fontSize) * localScale;
    let lineHeightPx = fontPx * 1.15;
    if (cs.lineHeight !== 'normal') {
      const lh = parseFloat(cs.lineHeight);
      if (!isNaN(lh)) lineHeightPx = lh * localScale;
    }
    let letterSpacingPx = 0;
    if (cs.letterSpacing !== 'normal') {
      const ls = parseFloat(cs.letterSpacing);
      if (!isNaN(ls)) letterSpacingPx = ls * localScale;
    }

    specs.push({
      el,
      x: (r.left - rootRect.left) * k,
      y: (r.top - rootRect.top) * k,
      w: r.width * k,
      h: r.height * k,
      fontPx,
      align,
      family: cs.fontFamily,
      weight,
      color: parseRgb(cs.color),
      lineHeightPx,
      letterSpacingPx,
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
  /**
   * When true, content taller than one page is automatically split across multiple pages.
   * Each page gets its own slice of the background raster and the text specs that fall
   * within that page's vertical range. Default: false (single page, content scaled to fit).
   */
  multiPage?: boolean;
  /** Background color for the raster capture (passed to snapdom). */
  backgroundColor?: string;
}

/** 1 typographic point in millimetres (72pt = 1in = 25.4mm). */
const PT_PER_MM = 1 / (25.4 / 72);

/**
 * Exports `el` as a "searchable raster" PDF: a pixel-faithful background with real, selectable vector
 * text drawn on top (see the module docstring). Returns once the file has been saved.
 *
 * When `multiPage` is true, content taller than one page is split across multiple pages automatically.
 */
export async function exportSearchablePdf(
  el: HTMLElement,
  opts: SearchablePdfOptions
): Promise<void> {
  const { default: jsPDF } = await import('jspdf');

  // 1. Measure the text runs while they are still visible (so colors/sizes are the real ones).
  const specs = collectTextSpecs(el, opts.naturalWidth);

  // 2. Hide the text for the background raster by injecting a global stylesheet.
  // We use a stylesheet rather than inline styles because Svelte's reactivity might
  // re-apply declarative inline `style:color` bindings during the async rasterization yield.
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .pdf-exporting-raster [data-pdf-text] {
      color: rgba(0,0,0,0) !important;
      text-shadow: none !important;
      -webkit-text-fill-color: rgba(0,0,0,0) !important;
    }
  `;
  document.head.appendChild(styleEl);
  el.classList.add('pdf-exporting-raster');

  let canvas: HTMLCanvasElement;
  try {
    const rasterOpts: RasterizeOptions = {
      scale: opts.rasterScale ?? 3,
      fonts: opts.fonts,
      backgroundColor: opts.backgroundColor,
    };
    canvas = await rasterizeElementToCanvas(el, rasterOpts);
  } finally {
    // 3. Always restore the visible text, even if the raster failed.
    el.classList.remove('pdf-exporting-raster');
    styleEl.remove();
  }

  // 4. Compose the PDF.
  const pdf = new jsPDF({ orientation: opts.orientation, unit: 'mm', format: opts.format });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  // Embed the real app fonts so the overlay text matches the on-screen typography exactly.
  await registerAppFonts(pdf);

  const mmPerPx = pageW / opts.naturalWidth;
  const jpegQuality = opts.jpegQuality ?? 0.9;

  if (opts.multiPage && opts.naturalHeight > 0) {
    // Multi-page: the element can be taller than one page. We slice the raster canvas into
    // page-sized vertical strips and distribute text specs across the pages they belong to.
    const pagePxH = pageH / mmPerPx; // one page height in natural px
    const totalPages = Math.max(1, Math.ceil(opts.naturalHeight / pagePxH));
    const rasterScale = canvas.width / opts.naturalWidth;

    for (let p = 0; p < totalPages; p++) {
      if (p > 0) pdf.addPage();

      // Slice the canvas for this page.
      const srcY = Math.round(p * pagePxH * rasterScale);
      const srcH = Math.min(Math.round(pagePxH * rasterScale), canvas.height - srcY);
      if (srcH <= 0) continue;

      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = srcH;
      const ctx = sliceCanvas.getContext('2d')!;
      ctx.drawImage(canvas, 0, srcY, canvas.width, srcH, 0, 0, canvas.width, srcH);

      const sliceImgH = (srcH / rasterScale) * mmPerPx;
      pdf.addImage(
        sliceCanvas.toDataURL('image/jpeg', jpegQuality),
        'JPEG',
        0,
        0,
        pageW,
        sliceImgH
      );

      // Draw text specs that belong to this page (their y falls within [pageTop, pageBottom)).
      const pageTopPx = p * pagePxH;
      const pageBottomPx = (p + 1) * pagePxH;
      const pageSpecs = specs.filter((s) => {
        const textMid = s.y + s.h / 2;
        return textMid >= pageTopPx && textMid < pageBottomPx;
      });
      drawTextSpecs(pdf, pageSpecs, mmPerPx, -pageTopPx);
    }
  } else {
    // Single page (original behaviour).
    pdf.addImage(canvas.toDataURL('image/jpeg', jpegQuality), 'JPEG', 0, 0, pageW, pageH);
    drawTextSpecs(pdf, specs, mmPerPx, 0);
  }

  const safe = opts.filename.replace(/[^a-zA-Z0-9À-ž\- ]/g, '_').trim() || 'export';
  pdf.save(`${safe}.pdf`);
}

/**
 * Draws a set of text specs onto the current page of a jsPDF document.
 * @param yOffset - Added to each spec's y coordinate (used to shift specs for multi-page slicing).
 */
function drawTextSpecs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdf: any,
  specs: TextSpec[],
  mmPerPx: number,
  yOffset: number
): void {
  for (const s of specs) {
    const font = pickAppFont(s.family, s.weight);
    if (font) pdf.setFont(font.name, font.style);
    else pdf.setFont('helvetica', s.weight >= 600 ? 'bold' : 'normal');
    pdf.setFontSize(s.fontPx * mmPerPx * PT_PER_MM);
    pdf.setTextColor(s.color.r, s.color.g, s.color.b);
    const boxW = s.w * mmPerPx;
    // If the text is single-line (height <= 1.2x line-height), pass a massive width to prevent jsPDF
    // from prematurely wrapping it due to sub-pixel font metric differences.
    // For multi-line text, add a small 1.5% tolerance for the same reason.
    const isMultiLine = s.h > s.lineHeightPx * 1.2;
    let safeBoxW = isMultiLine ? boxW * 1.015 : boxW * 100;

    // jsPDF's splitTextToSize ignores `charSpace` when measuring string width. If the text has
    // letter spacing, jsPDF thinks it takes up less space than it actually does and fails to wrap
    // it when the browser did. We compensate by shrinking the allowed width proportionally.
    if (isMultiLine && s.letterSpacingPx !== 0) {
      const numLines = Math.max(1, Math.round(s.h / s.lineHeightPx));
      const charsPerLine = s.text.length / numLines;
      const extraWidthPerLine = charsPerLine * s.letterSpacingPx * mmPerPx;
      safeBoxW = Math.max(10, safeBoxW - extraWidthPerLine);
    }

    const lines = pdf.splitTextToSize(s.text, safeBoxW);
    const anchorX = s.align === 'center' ? s.x + s.w / 2 : s.align === 'right' ? s.x + s.w : s.x;

    // In HTML, text is vertically centered in its line-height box.
    // jsPDF's 'top' and 'middle' baselines rely on internal font ascender/descender metrics
    // which are often buggy for custom fonts like Fredoka, causing text to be drawn too high
    // and cropped by the PDF viewer. We bypass this by manually computing the alphabetic
    // baseline. For most web fonts, the alphabetic baseline is located at roughly 35%
    // of the font-size below the vertical center of the line-height box.
    const anchorY = s.y + yOffset + s.lineHeightPx / 2 + s.fontPx * 0.35;

    pdf.text(lines, anchorX * mmPerPx, anchorY * mmPerPx, {
      align: s.align,
      // baseline: 'alphabetic' is the default in jsPDF
      lineHeightFactor: s.lineHeightPx / s.fontPx,
      charSpace: s.letterSpacingPx * mmPerPx,
    });
  }
}
