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
 *
 * WHERE A LINE BREAKS IS THE BROWSER'S ANSWER, AND IT IS READ, NEVER RE-DERIVED. A wrapped run is
 * measured line by line ({@link groupCharsIntoLines}) and each line is drawn at its own baseline.
 * Handing jsPDF a width and letting it re-break the string cannot work: it measures in its own
 * metrics, and it broke "Lounes BRIAND--RAVIDAT" as "BRIAND--R / AVIDAT" - mid-word - while the
 * preview showed it whole. A run that fits one line is drawn as one string, with nothing to decide.
 *
 * MARKUP CONTRACT: put `data-pdf-text` on the element whose box IS the text's line box - a bare
 * `<span>`, not a padded or flex-centred container. A run is anchored to the TOP of the marked box
 * ({@link drawTextSpecs}); padding and vertical centring are invisible here, so marking a container
 * silently draws its text higher in the PDF than the on-screen preview shows it.
 *
 * EMOJI ARE THE ONE EXCEPTION TO "HIDE FOR RASTER, RE-DRAW AS VECTOR": jsPDF's text embedding only
 * supports plain TrueType outlines, so a color emoji (COLRv1/OT-SVG, see the bundled Noto font) has
 * no vector form to draw. A `data-pdf-text` node containing emoji is therefore left OUT of the
 * hide-for-raster rule - captured pixel-perfect, in color, by the background raster pass - and its
 * vector re-draw is skipped so nothing invisible is drawn on top of it.
 */
import { rasterizeElementToCanvas, type RasterizeOptions } from '$lib/utils/pdfRaster';
import { containsEmoji } from '$lib/utils/emoji';
import { Log } from '$lib/utils/Log';
import { registerAppFonts, pickAppFont } from './appFonts';

/**
 * One line of a run, exactly as the BROWSER laid it out, in the root's natural coordinate space.
 *
 * The whole point of measuring these is that nothing downstream re-decides where a line breaks:
 * see {@link measureLineBoxes}.
 */
interface LineBox {
  /** The line's text, trimmed - a trailing space at a wrap hangs and is not drawn. */
  text: string;
  /** Left / right extent of the line's INKED glyphs (whitespace excluded), natural px. */
  left: number;
  right: number;
  /** This line's alphabetic baseline, natural px. */
  baselineY: number;
}

/** One measured character: its glyph box, or null where the browser gave it no box at all. */
export interface MeasuredChar {
  ch: string;
  rect: { top: number; left: number; right: number; height: number } | null;
}

/** A line as {@link groupCharsIntoLines} returns it, still in the coordinate space it measured in. */
export interface GroupedLine {
  text: string;
  left: number;
  right: number;
  top: number;
}

/**
 * Groups per-character boxes into the lines the browser actually produced.
 *
 * A new line starts where a character's box steps DOWN by more than half a glyph height - the one
 * signal that survives justification, centring and a hanging trailing space, none of which move a
 * glyph vertically. Kept pure (it takes measurements, not a DOM) because it is the half that can be
 * wrong, and the half a test can pin down: jsdom lays nothing out, so a DOM-reading version of this
 * could only ever be exercised in a real browser.
 *
 * A character the browser gave no box - the collapsed space AT a wrap - joins the current line's
 * text and is then trimmed away, rather than starting a line of its own.
 *
 * @param chars - Characters in document order, each with its measured box.
 * @returns One entry per line; `left`/`right` span the INKED glyphs only, so a centred line's
 *   midpoint is where the browser centred it.
 */
export function groupCharsIntoLines(chars: MeasuredChar[]): GroupedLine[] {
  const lines: GroupedLine[] = [];
  let current: GroupedLine | null = null;

  for (const { ch, rect } of chars) {
    // No box: a collapsed wrap space. It belongs to the line being built, and to no new one.
    if (!rect || (rect.height === 0 && rect.right === rect.left)) {
      if (current) current.text += ch;
      continue;
    }
    if (current === null || rect.top - current.top > Math.max(1, rect.height * 0.5)) {
      current = { text: ch, left: rect.left, right: rect.right, top: rect.top };
      lines.push(current);
      continue;
    }
    current.text += ch;
    // Whitespace does not widen a line: a trailing space hangs past the edge the browser aligned on.
    if (ch.trim() !== '') {
      current.left = Math.min(current.left, rect.left);
      current.right = Math.max(current.right, rect.right);
    }
  }

  return lines.map((l) => ({ ...l, text: l.text.trim() })).filter((l) => l.text !== '');
}

/**
 * Reads the lines a run was laid out on, straight from the browser, via one Range per character.
 *
 * WHY PER CHARACTER: `Range.getClientRects()` over the whole run returns one rect per line, but
 * says nothing about WHICH characters are on each - and the text is exactly what has to be drawn.
 * Walking the characters gives both at once. Only multi-line runs pay for it (see the caller), so
 * the overwhelming majority of runs - a name, a date, a heading - measure nothing at all.
 *
 * @returns The run's lines, or an EMPTY array where the browser laid nothing out (jsdom, a
 *   detached node): the caller treats that as a measurement failure, never as "no text".
 */
function measureLineBoxes(el: HTMLElement): GroupedLine[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const chars: MeasuredChar[] = [];
  const range = document.createRange();
  let measured = false;

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = (node as Text).data;
    for (let i = 0; i < data.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      const empty = r.width === 0 && r.height === 0;
      if (!empty) measured = true;
      chars.push({
        ch: data[i],
        rect: empty ? null : { top: r.top, left: r.left, right: r.right, height: r.height },
      });
    }
  }

  return measured ? groupCharsIntoLines(chars) : [];
}

/** One measured text run to re-draw as vector text over the raster. */
interface TextSpec {
  el: HTMLElement;
  /** Box, in the element's natural (unscaled) coordinate space. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Absolute y of the FIRST line's alphabetic baseline, measured in the DOM (natural px). */
  baselineY: number;
  /**
   * Rotation applied by CSS transforms between the root and the run, in degrees, clockwise as CSS
   * counts it. Non-zero only for a stamped word (the calendar's "Vacances").
   */
  angleDeg: number;
  /** Centre of the run's (possibly rotated) box, natural px. */
  cx: number;
  cy: number;
  /** The run's UNROTATED width, and its baseline measured from its centre along its own y axis. */
  localW: number;
  localBaseline: number;
  fontPx: number;
  align: 'left' | 'center' | 'right';
  /** The run's font-family stack + numeric weight, used to pick the matching embedded app font. */
  family: string;
  weight: number;
  color: { r: number; g: number; b: number };
  lineHeightPx: number;
  letterSpacingPx: number;
  text: string;
  /** True when `text` contains emoji - captured by the raster pass instead of drawn as vector text. */
  hasEmoji: boolean;
  /**
   * The lines the BROWSER broke this run into, when it needed more than one. Empty for a run that
   * fits one line (nothing to decide) and for one whose measurement failed - {@link drawTextSpecs}
   * tells those apart by {@link wrapUnmeasured}.
   */
  lines: LineBox[];
  /** True when the run wraps on screen but no line box could be read - a defect, and it is logged. */
  wrapUnmeasured: boolean;
}

/**
 * Applies a CSS `text-transform` to a string.
 *
 * It has to be applied to every drawn run AND to every measured line: a line's text is read from
 * the DOM text node, which holds the ORIGINAL case, while the glyphs on screen are the transformed
 * ones. Drawing the node's own text would print "lundi" over a raster that says "LUNDI".
 */
function applyTextTransform(text: string, textTransform: string): string {
  if (textTransform === 'uppercase') return text.toUpperCase();
  if (textTransform === 'lowercase') return text.toLowerCase();
  return text;
}

/** Parses a CSS `rgb()/rgba()` color into 0-255 components (defaults to black on parse failure). */
function parseRgb(css: string): { r: number; g: number; b: number } {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) return { r: 0, g: 0, b: 0 };
  const [r, g, b] = m[1].split(',').map((p) => parseInt(p.trim(), 10));
  return { r: r || 0, g: g || 0, b: b || 0 };
}

/**
 * Walks up the DOM from `el` to `root` (exclusive) and accumulates the visual scale and rotation
 * applied by CSS `transform`. The scale maps a layout size (like font-size) into the natural
 * coordinate space of the root element; the rotation is the angle a stamped word is drawn at.
 */
function getAccumulatedTransform(
  el: HTMLElement,
  root: HTMLElement
): { scale: number; angleDeg: number } {
  let scale = 1;
  let angleDeg = 0;
  let current: HTMLElement | null = el;
  while (current && current !== root) {
    const transform = getComputedStyle(current).transform;
    if (transform && transform !== 'none') {
      const match = transform.match(/^matrix(?:3d)?\((.+)\)$/);
      if (match) {
        const values = match[1].split(',').map(parseFloat);
        // scaleX is the length of the first column vector (m11, m12), and its direction the angle.
        const scaleX = Math.sqrt(values[0] * values[0] + values[1] * values[1]);
        if (scaleX > 0) scale *= scaleX;
        angleDeg += (Math.atan2(values[1], values[0]) * 180) / Math.PI;
      }
    }
    current = current.parentElement;
  }
  return { scale, angleDeg };
}

/**
 * Where the browser put the first line's alphabetic baseline, in client px.
 *
 * MEASURED, NEVER ESTIMATED. The overlay used to place it at `fontPx * 0.35` under the centre of
 * the line box, which is roughly right for Nunito and wrong for a display face whose ascender is
 * nothing like it - and once the raster keeps the text's hard-offset shadow, the glyph drawn over
 * it must land exactly where the browser drew it, or the shadow reads as a misprint. An empty
 * zero-size inline-block sits ON the baseline, so its box is that point, rotation included.
 */
function measureBaseline(el: HTMLElement): { x: number; y: number } {
  const probe = document.createElement('span');
  probe.style.cssText =
    'display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline;';
  el.prepend(probe);
  const r = probe.getBoundingClientRect();
  probe.remove();
  return { x: r.left, y: r.top };
}

/** Reads every `[data-pdf-text]` run under `root`, converted into the root's natural coordinate space. */
function collectTextSpecs(root: HTMLElement, naturalWidth: number): TextSpec[] {
  const rootRect = root.getBoundingClientRect();
  // The element may be rendered under a CSS transform (preview zoom); k maps client px -> natural px.
  const k = rootRect.width > 0 ? naturalWidth / rootRect.width : 1;
  const specs: TextSpec[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-pdf-text]')) {
    const raw = (el.textContent ?? '').trim();
    if (!raw) continue;
    const cs = getComputedStyle(el);
    const text = applyTextTransform(raw, cs.textTransform);
    const r = el.getBoundingClientRect();
    const rawAlign = cs.textAlign;
    const align = rawAlign === 'center' ? 'center' : rawAlign === 'right' ? 'right' : 'left';
    const parsedWeight = parseInt(cs.fontWeight, 10);
    const weight = Number.isFinite(parsedWeight)
      ? parsedWeight
      : cs.fontWeight === 'bold'
        ? 700
        : 400;
    const { scale: localScale, angleDeg } = getAccumulatedTransform(el, root);
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

    // The baseline, re-expressed in the run's own frame: offset from the box centre, rotated back
    // by the run's angle. For an unrotated run only `baselineY` is read, and it is the measured y.
    const base = measureBaseline(el);
    const cx = ((r.left + r.right) / 2 - rootRect.left) * k;
    const cy = ((r.top + r.bottom) / 2 - rootRect.top) * k;
    const dx = (base.x - rootRect.left) * k - cx;
    const dy = (base.y - rootRect.top) * k - cy;
    const theta = (angleDeg * Math.PI) / 180;

    // WHERE A LINE BREAKS IS THE BROWSER'S ANSWER, AND IT IS READ HERE RATHER THAN RE-DERIVED.
    // Only a run that actually wraps is measured: a rotated run is a one-line stamp by construction,
    // and a run no taller than its line height has nothing to break.
    const h = r.height * k;
    const wraps = Math.abs(angleDeg) <= 0.5 && h > lineHeightPx * 1.2;
    const measured = wraps ? measureLineBoxes(el) : [];
    // The gap from a line box's top to its baseline is the same on every line of a run (one font,
    // one line height), so the baseline measured on the first line places all the others.
    const baselineFromTop = measured.length > 0 ? base.y - measured[0].top : 0;
    const lines: LineBox[] = measured.map((l) => ({
      text: applyTextTransform(l.text, cs.textTransform),
      left: (l.left - rootRect.left) * k,
      right: (l.right - rootRect.left) * k,
      baselineY: (l.top + baselineFromTop - rootRect.top) * k,
    }));

    specs.push({
      lines,
      wrapUnmeasured: wraps && lines.length === 0,
      el,
      x: (r.left - rootRect.left) * k,
      y: (r.top - rootRect.top) * k,
      w: r.width * k,
      h,
      baselineY: (base.y - rootRect.top) * k,
      angleDeg,
      cx,
      cy,
      localW: el.offsetWidth * localScale,
      localBaseline: -dx * Math.sin(theta) + dy * Math.cos(theta),
      fontPx,
      align,
      family: cs.fontFamily,
      weight,
      color: parseRgb(cs.color),
      lineHeightPx,
      letterSpacingPx,
      text,
      // A picture (`img.emoji`) is not in `textContent`, so the text alone would call this node plain
      // and hide it - picture included - for the vector pass.
      hasEmoji: containsEmoji(text) || el.querySelector('img.emoji') !== null,
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

  // A run that wraps on screen and yielded no line box is a DEFECT, not a variant: the export is
  // about to let jsPDF re-break that text in its own metrics, which is exactly what this pipeline
  // exists to avoid. Named here so it accuses rather than passing silently.
  const unmeasured = specs.filter((s) => s.wrapUnmeasured);
  if (unmeasured.length > 0) {
    Log.d('searchableRaster:wrapUnmeasured', {
      count: unmeasured.length,
      samples: unmeasured.slice(0, 3).map((s) => s.text.slice(0, 40)),
    });
  }

  // An emoji-carrying node is marked so the stylesheet below can exempt it from the hide rule -
  // it has no vector form (see the module docstring), so it must survive into the raster instead.
  const emojiEls = specs.filter((s) => s.hasEmoji).map((s) => s.el);
  for (const node of emojiEls) node.dataset.pdfTextRasterOnly = 'true';

  // 2. Hide the text for the background raster by injecting a global stylesheet.
  // We use a stylesheet rather than inline styles because Svelte's reactivity might
  // re-apply declarative inline `style:color` bindings during the async rasterization yield.
  //
  // THE GLYPHS GO, THE SHADOW STAYS. A text-shadow is painted from the glyph outline whatever the
  // fill, so a transparent run leaves its shadow in the raster and the vector glyph lands on top of
  // it - the pair the preview shows. Stripping it too erased the calendar sheet's block shadow, the
  // accent-red duplicate that IS its title (2026-09-27).
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .pdf-exporting-raster [data-pdf-text]:not([data-pdf-text-raster-only]) {
      color: rgba(0,0,0,0) !important;
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
    for (const node of emojiEls) delete node.dataset.pdfTextRasterOnly;
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
    // Captured in color by the raster pass instead (see the module docstring) - drawing a vector
    // run on top would either duplicate the text or, worse, paint nothing over a colorless glyph.
    if (s.hasEmoji) continue;
    const font = pickAppFont(s.family, s.weight);
    if (font) pdf.setFont(font.name, font.style);
    else pdf.setFont('helvetica', s.weight >= 600 ? 'bold' : 'normal');
    pdf.setFontSize(s.fontPx * mmPerPx * PT_PER_MM);
    pdf.setTextColor(s.color.r, s.color.g, s.color.b);
    const charSpace = s.letterSpacingPx * mmPerPx;

    // A ROTATED RUN IS A STAMP: one line, drawn at its own angle from where its baseline starts.
    // jsPDF's `align` shifts along the page's x axis rather than the text's, so the start point is
    // computed here, in the run's frame, and rotated onto the page. CSS turns clockwise for a
    // positive angle and jsPDF counter-clockwise, hence the sign.
    if (Math.abs(s.angleDeg) > 0.5) {
      const theta = (s.angleDeg * Math.PI) / 180;
      const textW = pdf.getTextWidth(s.text) + charSpace * Math.max(0, s.text.length - 1);
      const halfW = (s.localW * mmPerPx) / 2;
      const lx = s.align === 'center' ? -textW / 2 : s.align === 'right' ? halfW - textW : -halfW;
      const ly = s.localBaseline * mmPerPx;
      const cx = s.cx * mmPerPx;
      const cy = (s.cy + yOffset) * mmPerPx;
      pdf.text(
        s.text,
        cx + lx * Math.cos(theta) - ly * Math.sin(theta),
        cy + lx * Math.sin(theta) + ly * Math.cos(theta),
        { angle: -s.angleDeg, charSpace }
      );
      continue;
    }

    // THE BROWSER ALREADY BROKE THIS RUN, SO NOTHING HERE BREAKS IT AGAIN: each line is drawn at
    // its own measured baseline, anchored on its own inked extent. Re-deriving the breaks from a
    // width is what split "Lounes BRIAND--R / AVIDAT" across two lines mid-word while the preview
    // showed it whole - jsPDF measures in its own metrics and cannot reach the browser's answer.
    if (s.lines.length > 0) {
      for (const line of s.lines) {
        const anchor =
          s.align === 'center'
            ? (line.left + line.right) / 2
            : s.align === 'right'
              ? line.right
              : line.left;
        pdf.text(line.text, anchor * mmPerPx, (line.baselineY + yOffset) * mmPerPx, {
          align: s.align,
          charSpace,
        });
      }
      continue;
    }

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

    // The first line's baseline where the browser measured it (see `measureBaseline`); jsPDF's
    // own 'top'/'middle' baselines trust font metrics that are wrong for several of these faces.
    const anchorY = s.baselineY + yOffset;

    pdf.text(lines, anchorX * mmPerPx, anchorY * mmPerPx, {
      align: s.align,
      // baseline: 'alphabetic' is the default in jsPDF
      lineHeightFactor: s.lineHeightPx / s.fontPx,
      charSpace,
    });
  }
}
