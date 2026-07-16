/**
 * Shared DOM-to-canvas rasteriser for the client-side PDF exports (monthly calendar, trombinoscope).
 *
 * Uses snapdom, which serialises the subtree into an SVG `<foreignObject>` and lets the browser's own
 * engine paint it. Modern CSS - flexbox, `-webkit-line-clamp`, variable fonts - therefore renders
 * exactly as it does on screen. This replaces html2canvas, which reimplemented CSS layout in JS and
 * mis-rendered clamped/flex-centred event titles (glyphs clipped to a thin band in the PDF while the
 * DOM preview was correct).
 */

/** Options for {@link rasterizeElementToCanvas}. */
export interface RasterizeOptions {
  /** Output scale multiplier (e.g. 2 for retina-quality raster). Default: 2. */
  scale?: number;
  /** Solid background color painted behind the capture (hex). */
  backgroundColor?: string;
  /**
   * `document.fonts.load()` shorthand strings to force-load before capture (e.g.
   * `"700 30px 'Fredoka Variable'"`), so the browser rasterises the real Canari *Variable* families
   * instead of a fallback and snapdom embeds them in the SVG. Failures are ignored.
   */
  fonts?: string[];
}

/**
 * Rasterises a live (already DOM-attached) element to a canvas via snapdom.
 *
 * The caller owns the element lifecycle: append it offscreen (e.g. `left:-9999px`) before calling and
 * remove it afterwards. Images inside the subtree must be same-origin or `data:` URLs so snapdom can
 * inline them; this helper first waits for every `<img>` to settle so the capture is never missing an
 * avatar or logo.
 *
 * @param el - The attached element to capture.
 * @param opts - Scale, background color and fonts to force-load.
 * @returns A canvas holding the rasterised snapshot (feed `toDataURL()` to jsPDF).
 */
export async function rasterizeElementToCanvas(
  el: HTMLElement,
  opts: RasterizeOptions = {}
): Promise<HTMLCanvasElement> {
  const { scale = 2, backgroundColor, fonts = [] } = opts;

  // Wait for every <img> (avatars, logos, background) to load or error so the capture is complete.
  await Promise.all(
    Array.from(el.querySelectorAll<HTMLImageElement>('img')).map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) resolve();
          else {
            img.onload = () => resolve();
            img.onerror = () => resolve();
          }
        })
    )
  );

  // Force-load the exact families used by the export so the real fonts are available before capture.
  if (fonts.length > 0) {
    await Promise.all(fonts.map((f) => document.fonts.load(f))).catch(() => {});
  }
  await document.fonts.ready;

  // Dynamic import keeps snapdom out of the main bundle (only pulled in when a PDF is exported).
  const { snapdom } = await import('@zumer/snapdom');
  return snapdom.toCanvas(el, { scale, backgroundColor, embedFonts: true });
}
