/**
 * Shared DOM-to-canvas rasteriser for the client-side PDF exports (monthly calendar, trombinoscope,
 * association cartography poster).
 *
 * Uses snapdom, which serialises the subtree into an SVG `<foreignObject>` and lets the browser's own
 * engine paint it. Modern CSS - flexbox, `-webkit-line-clamp`, variable fonts - therefore renders
 * exactly as it does on screen. This replaces html2canvas, which reimplemented CSS layout in JS and
 * mis-rendered clamped/flex-centred event titles (glyphs clipped to a thin band in the PDF while the
 * DOM preview was correct).
 */

import { Log } from './Log';

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
  //
  // `addEventListener`, NEVER `img.onerror = ...`: the property assignment REPLACED the call site's
  // own error handler, and the trombinoscope builds its cards microseconds before exporting, so its
  // avatars were always still loading when we got here. A 404 avatar therefore lost the very handler
  // that reveals the initials behind it.
  const images = Array.from(el.querySelectorAll<HTMLImageElement>('img'));
  const pixelless = new Set<HTMLImageElement>();
  await Promise.all(
    images.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) {
            // `complete` is true for a FAILED image too, so the intrinsic size is what separates
            // them. An intrinsically sizeless source (an SVG with no width/height) lands here as
            // well - rare in the exports, and a debug line is the whole cost.
            if (img.naturalWidth === 0) pixelless.add(img);
            resolve();
            return;
          }
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener(
            'error',
            () => {
              pixelless.add(img);
              resolve();
            },
            { once: true }
          );
        })
    )
  );

  // An <img> with no pixels is dropped from the capture by `placeholders: false` below, so it is
  // named here. A KNOWN absence is not one of these: a member with no photo has its `<img>` removed
  // by the call site's own `error` handler, which is why only a node still in the tree is reported.
  const missing = Array.from(pixelless).filter((img) => img.isConnected);
  if (missing.length > 0) {
    Log.d('pdfRaster:missingImages', {
      count: missing.length,
      srcs: missing.map((img) => img.src),
    });
  }

  // Force-load the exact families used by the export so the real fonts are available before capture.
  if (fonts.length > 0) {
    await Promise.all(fonts.map((f) => document.fonts.load(f))).catch(() => {});
  }
  await document.fonts.ready;

  // Dynamic import keeps snapdom out of the main bundle (only pulled in when a PDF is exported).
  const { snapdom } = await import('@zumer/snapdom');
  // `placeholders: false`: snapdom substitutes every <img> it cannot inline - a display:none one
  // INCLUDED - with an in-flow grey box reading "img", which is how the literal word "img" landed
  // beside the initials on an exported poster. Off, the substitute is an invisible spacer, and the
  // loop above has already named whatever it swallowed.
  return snapdom.toCanvas(el, {
    scale,
    backgroundColor,
    embedFonts: true,
    placeholders: false,
  });
}
