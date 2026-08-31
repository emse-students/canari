/**
 * Rendering a public Canari link as a QR code with the bird in the middle.
 *
 * The symbol is drawn here from `qrcode`'s module matrix instead of through that library's own
 * canvas renderer, for three reasons that all decide whether a phone actually reads the result:
 *
 * - **every module is an integer number of pixels.** A renderer asked for a symbol "1024 px wide"
 *   scales the grid to fit, which leaves fractional module edges, and the antialiasing that fills
 *   them is exactly the grey a decoder then has to threshold. Here the canvas is sized FROM the
 *   module size, so the grid never lands between pixels.
 * - **neighbouring modules are ONE shape.** A corner is rounded only where both modules that would
 *   have squared it off are light ({@link moduleCorners}), so a run of dark modules becomes a
 *   single stroke with rounded ends and only the symbol's outer silhouette is softened. That was
 *   measured, not chosen: drawing each module as a separate dot with a gap around it loses more
 *   than half the decodes at ordinary preview sizes, because an adaptive binariser averages the
 *   gaps in with the ink. Rounding only the free corners keeps the covered area, and the whole
 *   grid is filled as a single path so no antialiased seam is left between two dark neighbours.
 * - **the hole the logo sits in is measured in MODULES**, centred on the symbol's middle module, so
 *   what the badge destroys is known before it is drawn ({@link logoBadge},
 *   {@link logoBadgeDamageRatio}) rather than being whatever a percentage of pixels happened to
 *   cover. That is what makes "still legible" a measurement and not a hope.
 *
 * The colours are FIXED, dark-on-light, and deliberately do NOT follow the theme: an inverted code
 * (light modules on a dark ground) is outside what the spec asks a decoder to expect and a real
 * share of scanners refuse it, so a reader in dark mode gets the same white plate as everyone else.
 * The gradient stays inside that rule - both of its stops are dark enough to threshold as dark
 * against white, which is why it runs between two DARK brand colours and not into the yellow.
 *
 * There is no bare-symbol path when the bird fails to load: it is a bundled asset served from the
 * app's own origin, so its absence means the build is broken, and rendering a silently different
 * image would hide that. The rejection reaches the caller, which reports it.
 */

import type { QRCode as QrSymbol } from 'qrcode';
import { slugify } from '$lib/utils/textFold';

/**
 * Error correction level. 'H' recovers 30% of the codewords, and that budget is what pays for
 * the badge in the middle - see {@link logoBadgeDamageRatio}.
 */
const ERROR_CORRECTION = 'H' as const;

/** Quiet zone in modules. Four is the spec's minimum, and a scanner needs it to find the symbol. */
export const QR_QUIET_ZONE_MODULES = 4;

/** Start of the diagonal gradient: `--color-cn-ink`, the brand's fixed near-black. */
export const QR_GRADIENT_FROM = '#151b2c';

/**
 * End of the diagonal gradient: a deep amber that carries the brand's warmth without leaving the
 * dark half of the scale - it stays near 6:1 against white, where a decoder wants about 3:1.
 */
export const QR_GRADIENT_TO = '#6b3f05';

/** Light modules and quiet zone. */
export const QR_LIGHT_COLOR = '#ffffff';

/** Ground of the centre badge, behind the bird. The brand ink, so the yellow reads against it. */
export const QR_BADGE_GROUND_COLOR = '#151b2c';

/**
 * Corner radius of a module, as a fraction of its side. A half rounds a free corner into a true
 * quarter-circle, so an isolated module is a disc and a run of them is a capsule.
 */
export const QR_MODULE_RADIUS_FRACTION = 0.5;

/** Side of a finder pattern, in modules. Fixed by the spec at every version. */
export const QR_FINDER_MODULES = 7;

/** Corner radii of a finder's outer ring, of the light square punched into it, and of its eye. */
const FINDER_OUTER_RADIUS_MODULES = 2.1;
const FINDER_INNER_RADIUS_MODULES = 1.5;
const FINDER_EYE_RADIUS_MODULES = 1;

/**
 * Side of the centre hole as a fraction of the symbol's side. 0.22 keeps the erased square under
 * a twentieth of the symbol's area, well inside 'H' recovery, and no version's finder patterns
 * come anywhere near it.
 */
const LOGO_SIDE_FRACTION = 0.22;

/** Corner radius of the badge, as a fraction of its side. */
const BADGE_RADIUS_FRACTION = 0.3;

/** Side of the badge's ink ground as a fraction of the hole, leaving a white safety margin. */
const BADGE_GROUND_FRACTION = 0.8;

/** Fraction of the badge's side the bird itself occupies, inside that ink ground. */
const LOGO_FILL_FRACTION = 0.58;

/** Public path of the bird: a 2-colour palette PNG, 337x325, transparent ground. */
export const QR_LOGO_SRC = '/favicon.png';

/**
 * The app's own two faces, bundled by `@fontsource-variable` and declared in `app.css`: Fredoka
 * for headings, Nunito for text. The caption is a heading and a line under it, so it takes both.
 */
const CAPTION_TITLE_FONT = '"Fredoka Variable", "Fredoka", "Segoe UI", sans-serif';
const CAPTION_SUBTITLE_FONT = '"Nunito Variable", "Nunito", "Segoe UI", sans-serif';

/** `--text-main` and `--text-muted` in their light-theme values - the plate is always light. */
export const QR_CAPTION_TITLE_COLOR = '#102136';
export const QR_CAPTION_SUBTITLE_COLOR = '#607188';

/** Caption metrics, as fractions of the plate's width, so a print scales with the code. */
const CAPTION_TITLE_SIZE_FRACTION = 0.055;
const CAPTION_SUBTITLE_SIZE_FRACTION = 0.04;
const CAPTION_LINE_HEIGHT = 1.25;
const CAPTION_SIDE_PADDING_FRACTION = 0.08;
const CAPTION_BOTTOM_PADDING_FRACTION = 0.045;

/** A long title wraps, then stops: a third line would push the code out of a poster's frame. */
const CAPTION_MAX_TITLE_LINES = 2;

/** Pixel side the exported PNG aims for; the real one is rounded DOWN to whole modules. */
export const QR_EXPORT_TARGET_PX = 1024;

/** A rounded square, in modules: half its side, and the radius of its corners. */
export interface QrRoundedSquare {
  half: number;
  radius: number;
}

/** The three stacked rounded squares one finder pattern is made of, centred on (cx, cy). */
export interface QrFinderShape {
  /** Centre of the finder, in modules from the symbol's top-left corner. */
  cx: number;
  cy: number;
  /** The dark 7x7. */
  outer: QrRoundedSquare;
  /** The light 5x5 punched out of it. */
  inner: QrRoundedSquare;
  /** The dark 3x3 eye. */
  eye: QrRoundedSquare;
}

/** What the exported plate says under the code. */
export interface QrCaption {
  /** The thing being shared, by name - a form's title at every current call site. */
  title: string;
  /** Who is behind it, when that is known. Left out entirely when absent. */
  subtitle?: string | null;
}

/** Which of a module's four corners are free to be rounded - see {@link moduleCorners}. */
export interface QrModuleCorners {
  topLeft: boolean;
  topRight: boolean;
  bottomRight: boolean;
  bottomLeft: boolean;
}

/** Geometry of the centred logo badge, expressed in modules of the symbol it sits on. */
export interface QrLogoBadge {
  /** Side of the square of modules the badge covers. Odd, so it centres on the middle module. */
  holeModules: number;
  /** Row and column (equal, the badge is centred) of the hole's first module. */
  offsetModules: number;
}

/**
 * Places the badge on a symbol of `symbolModules` modules a side.
 *
 * A QR symbol's side is always odd (21 + 4k), so the hole is forced odd too: an even hole has no
 * middle module to centre on and lands half a module off, which turns two rings of modules into
 * half-covered ambiguity instead of one clean ring of damage.
 */
export function logoBadge(symbolModules: number): QrLogoBadge {
  const target = Math.floor(symbolModules * LOGO_SIDE_FRACTION);
  const holeModules = Math.max(1, target % 2 === 0 ? target - 1 : target);
  return { holeModules, offsetModules: (symbolModules - holeModules) / 2 };
}

/**
 * Upper bound on the share of the symbol's modules the badge destroys.
 *
 * The badge's own corners are rounded, so it covers slightly less than the square counted here;
 * bounding it above is the honest direction to be wrong in. This is the number to compare against
 * the 30% 'H' recovers, and the reason {@link LOGO_SIDE_FRACTION} is not tuned by eye.
 */
export function logoBadgeDamageRatio(symbolModules: number): number {
  const { holeModules } = logoBadge(symbolModules);
  return (holeModules * holeModules) / (symbolModules * symbolModules);
}

/** Builds the module matrix for `text` at the level the badge is budgeted against. */
export async function qrSymbol(text: string): Promise<QrSymbol> {
  const { create } = await import('qrcode');
  return create(text, { errorCorrectionLevel: ERROR_CORRECTION });
}

/** True when the module at (row, col) is dark. Out-of-range coordinates are light. */
export function isDarkModule(symbol: QrSymbol, row: number, col: number): boolean {
  const size = symbol.modules.size;
  if (row < 0 || col < 0 || row >= size || col >= size) return false;
  return symbol.modules.data[row * size + col] === 1;
}

/**
 * Top-left module of each of the three finder patterns, on a symbol `symbolModules` a side.
 *
 * They are drawn as one shape rather than module by module, so everything else must know to leave
 * their squares alone - {@link isFinderModule}.
 */
export function finderOrigins(symbolModules: number): Array<{ row: number; col: number }> {
  const far = symbolModules - QR_FINDER_MODULES;
  return [
    { row: 0, col: 0 },
    { row: 0, col: far },
    { row: far, col: 0 },
  ];
}

/**
 * The three finders as geometry, in modules - the single place their shape is decided.
 *
 * Both the canvas and the test read it, which is the only way "the test rasterises what the
 * renderer paints" can stay true of a shape someone later retunes.
 */
export function finderShapes(symbolModules: number): QrFinderShape[] {
  return finderOrigins(symbolModules).map((origin) => ({
    cx: origin.col + QR_FINDER_MODULES / 2,
    cy: origin.row + QR_FINDER_MODULES / 2,
    outer: { half: QR_FINDER_MODULES / 2, radius: FINDER_OUTER_RADIUS_MODULES },
    inner: { half: 2.5, radius: FINDER_INNER_RADIUS_MODULES },
    eye: { half: 1.5, radius: FINDER_EYE_RADIUS_MODULES },
  }));
}

/** The badge's hole as geometry, in modules - read by the canvas and by the test alike. */
export function badgeShape(symbolModules: number): QrRoundedSquare & { cx: number; cy: number } {
  const { holeModules, offsetModules } = logoBadge(symbolModules);
  const centre = offsetModules + holeModules / 2;
  return {
    cx: centre,
    cy: centre,
    half: holeModules / 2,
    radius: holeModules * BADGE_RADIUS_FRACTION,
  };
}

/** True when (row, col) falls inside one of the three finder squares. */
export function isFinderModule(symbolModules: number, row: number, col: number): boolean {
  return finderOrigins(symbolModules).some(
    (origin) =>
      row >= origin.row &&
      row < origin.row + QR_FINDER_MODULES &&
      col >= origin.col &&
      col < origin.col + QR_FINDER_MODULES
  );
}

/**
 * Which corners of a dark module may be rounded: the ones where BOTH neighbours sharing that
 * corner are light.
 *
 * This is what turns the grid into strokes. Round a corner whose neighbour is dark and the shape
 * pulls away from that neighbour, leaving a light notch inside what should read as one solid run;
 * requiring both keeps every dark-to-dark edge square and only softens the silhouette.
 */
export function moduleCorners(symbol: QrSymbol, row: number, col: number): QrModuleCorners {
  const up = isDarkModule(symbol, row - 1, col);
  const down = isDarkModule(symbol, row + 1, col);
  const left = isDarkModule(symbol, row, col - 1);
  const right = isDarkModule(symbol, row, col + 1);
  return {
    topLeft: !up && !left,
    topRight: !up && !right,
    bottomRight: !down && !right,
    bottomLeft: !down && !left,
  };
}

/**
 * True when the point (x, y) is inside the module of half-side `half` centred on (cx, cy) with
 * `corners` rounded by `radius` - the EXACT shape {@link modulePath} draws, in the caller's unit.
 *
 * Having the shape as a predicate as well as a path is what lets the test rasterise what this
 * module really paints and hand it to a decoder, instead of asserting on an approximation.
 */
export function moduleContains(
  x: number,
  y: number,
  cx: number,
  cy: number,
  half: number,
  radius: number,
  corners: QrModuleCorners
): boolean {
  const dx = x - cx;
  const dy = y - cy;
  if (Math.abs(dx) > half || Math.abs(dy) > half) return false;

  const r = Math.min(radius, half);
  const flat = half - r;
  if (Math.abs(dx) <= flat || Math.abs(dy) <= flat) return true;

  const rounded =
    dy < 0
      ? dx < 0
        ? corners.topLeft
        : corners.topRight
      : dx < 0
        ? corners.bottomLeft
        : corners.bottomRight;
  if (!rounded) return true;

  const ox = dx < 0 ? -flat : flat;
  const oy = dy < 0 ? -flat : flat;
  return (dx - ox) * (dx - ox) + (dy - oy) * (dy - oy) <= r * r;
}

/**
 * True when the point (x, y) is inside the rounded square of half-side `half` centred on
 * (cx, cy) - the shape {@link roundedSquarePath} draws, used for the finders and the badge.
 *
 * A rounded square is the set of points within `radius` of the square shrunk by `radius`, which is
 * what the two clamped distances below measure.
 */
export function roundedSquareContains(
  x: number,
  y: number,
  cx: number,
  cy: number,
  half: number,
  radius: number
): boolean {
  const r = Math.min(radius, half);
  const dx = Math.max(Math.abs(x - cx) - (half - r), 0);
  const dy = Math.max(Math.abs(y - cy) - (half - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/**
 * Adds one module's outline to the current path, rounding only its free corners.
 *
 * Nothing here uses `ctx.roundRect`: that method is recent, this runs inside the Android WebView
 * of whatever phone the user happens to hold, and it could not take a per-corner flag anyway.
 */
function modulePath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  half: number,
  radius: number,
  corners: QrModuleCorners
): void {
  const r = Math.min(radius, half);
  const left = cx - half;
  const right = cx + half;
  const top = cy - half;
  const bottom = cy + half;
  const tl = corners.topLeft ? r : 0;
  const tr = corners.topRight ? r : 0;
  const br = corners.bottomRight ? r : 0;
  const bl = corners.bottomLeft ? r : 0;

  ctx.moveTo(left + tl, top);
  ctx.lineTo(right - tr, top);
  if (tr) ctx.arcTo(right, top, right, top + tr, tr);
  ctx.lineTo(right, bottom - br);
  if (br) ctx.arcTo(right, bottom, right - br, bottom, br);
  ctx.lineTo(left + bl, bottom);
  if (bl) ctx.arcTo(left, bottom, left, bottom - bl, bl);
  ctx.lineTo(left, top + tl);
  if (tl) ctx.arcTo(left, top, left + tl, top, tl);
  ctx.closePath();
}

/** Traces the rounded square {@link roundedSquareContains} describes, as its own path. */
function roundedSquarePath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  half: number,
  radius: number
): void {
  const r = Math.min(radius, half);
  const left = cx - half;
  const right = cx + half;
  const top = cy - half;
  const bottom = cy + half;
  ctx.beginPath();
  ctx.moveTo(left + r, top);
  ctx.arcTo(right, top, right, bottom, r);
  ctx.arcTo(right, bottom, left, bottom, r);
  ctx.arcTo(left, bottom, left, top, r);
  ctx.arcTo(left, top, right, top, r);
  ctx.closePath();
}

/** Loads the bird. Rejects when the asset is missing - see the module header on why nothing else. */
async function loadLogo(): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = QR_LOGO_SRC;
  await image.decode();
  console.debug(`[qr] logo decoded (${image.naturalWidth}x${image.naturalHeight})`);
  return image;
}

/** The diagonal the gradient runs along, from the symbol's top-left corner to its bottom-right. */
function moduleGradient(ctx: CanvasRenderingContext2D, canvasPx: number): CanvasGradient {
  const gradient = ctx.createLinearGradient(0, 0, canvasPx, canvasPx);
  gradient.addColorStop(0, QR_GRADIENT_FROM);
  gradient.addColorStop(1, QR_GRADIENT_TO);
  return gradient;
}

/**
 * Paints the three finder patterns as rounded rings with a rounded eye.
 *
 * The spec's finder is a dark 7x7 with a light 5x5 inside it and a dark 3x3 inside that; only the
 * corners are softened here, so a scanline through the middle still crosses the 1:1:3:1:1 run a
 * decoder looks for. The light square is punched OUT of the ring rather than drawn around it,
 * which is what keeps the ring exactly one module thick.
 */
function drawFinders(
  ctx: CanvasRenderingContext2D,
  symbolModules: number,
  modulePx: number,
  origin: number,
  ink: CanvasGradient
): void {
  for (const finder of finderShapes(symbolModules)) {
    const cx = origin + finder.cx * modulePx;
    const cy = origin + finder.cy * modulePx;
    const fill = (square: QrRoundedSquare, style: string | CanvasGradient) => {
      ctx.fillStyle = style;
      roundedSquarePath(ctx, cx, cy, square.half * modulePx, square.radius * modulePx);
      ctx.fill();
    };

    fill(finder.outer, ink);
    fill(finder.inner, QR_LIGHT_COLOR);
    fill(finder.eye, ink);
  }
}

/**
 * Paints the quiet zone, then every dark module outside the finders.
 *
 * All of them go into ONE path filled once: two dark neighbours share an edge exactly, and filling
 * them separately would antialias that shared edge twice and leave a pale seam down the middle of
 * every stroke.
 */
function drawModules(
  ctx: CanvasRenderingContext2D,
  symbol: QrSymbol,
  modulePx: number,
  canvasPx: number
): void {
  ctx.fillStyle = QR_LIGHT_COLOR;
  ctx.fillRect(0, 0, canvasPx, canvasPx);

  const size = symbol.modules.size;
  const origin = QR_QUIET_ZONE_MODULES * modulePx;
  const ink = moduleGradient(ctx, canvasPx);
  const half = modulePx / 2;
  const radius = QR_MODULE_RADIUS_FRACTION * modulePx;

  ctx.fillStyle = ink;
  ctx.beginPath();
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!isDarkModule(symbol, row, col) || isFinderModule(size, row, col)) continue;
      modulePath(
        ctx,
        origin + (col + 0.5) * modulePx,
        origin + (row + 0.5) * modulePx,
        half,
        radius,
        moduleCorners(symbol, row, col)
      );
    }
  }
  ctx.fill();

  drawFinders(ctx, size, modulePx, origin, ink);
}

/**
 * Erases the badge's square and draws the bird inside it.
 *
 * Three stacked fills: the white hole, which is what the decoder must see instead of a
 * half-covered module it might read either way; the ink ground, because the bird is a single
 * yellow and yellow on white is barely a shape; and the bird.
 */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  symbol: QrSymbol,
  logo: HTMLImageElement,
  modulePx: number
): void {
  const badge = badgeShape(symbol.modules.size);
  const origin = QR_QUIET_ZONE_MODULES * modulePx;
  const side = badge.half * 2 * modulePx;
  const centre = origin + badge.cx * modulePx;

  ctx.fillStyle = QR_LIGHT_COLOR;
  roundedSquarePath(ctx, centre, centre, badge.half * modulePx, badge.radius * modulePx);
  ctx.fill();

  ctx.fillStyle = QR_BADGE_GROUND_COLOR;
  roundedSquarePath(
    ctx,
    centre,
    centre,
    badge.half * BADGE_GROUND_FRACTION * modulePx,
    badge.radius * BADGE_GROUND_FRACTION * modulePx
  );
  ctx.fill();

  const scale = (side * LOGO_FILL_FRACTION) / Math.max(logo.naturalWidth, logo.naturalHeight, 1);
  const width = logo.naturalWidth * scale;
  const height = logo.naturalHeight * scale;
  ctx.drawImage(logo, centre - width / 2, centre - height / 2, width, height);
}

/**
 * Waits for the app's own faces to be usable on a canvas.
 *
 * A canvas draws text with whatever is loaded AT THAT INSTANT and falls back silently otherwise,
 * so a plate rendered before the face arrives is quietly in Segoe UI and nothing says so. Asking
 * for them by the exact size they will be drawn at is what makes the wait mean something; a face
 * the document does not have at all is an accusation, not a shrug.
 */
async function loadCaptionFonts(titlePx: number, subtitlePx: number): Promise<void> {
  const wanted = [
    `700 ${titlePx}px ${CAPTION_TITLE_FONT}`,
    `600 ${subtitlePx}px ${CAPTION_SUBTITLE_FONT}`,
  ];
  const loaded = await Promise.all(wanted.map((font) => document.fonts.load(font)));
  loaded.forEach((faces, index) => {
    if (faces.length === 0) console.error(`[qr] caption font unavailable: ${wanted[index]}`);
  });
}

/** Breaks `text` to `maxWidth`, at word boundaries, and elides what will not fit in `maxLines`. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.trim().split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = candidate;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);

  // A single word wider than the plate never hits the break above, so the last line is clipped here.
  const last = lines.length - 1;
  if (last >= 0 && ctx.measureText(lines[last]).width > maxWidth) {
    let clipped = lines[last];
    while (clipped.length > 1 && ctx.measureText(`${clipped}...`).width > maxWidth) {
      clipped = clipped.slice(0, -1);
    }
    lines[last] = `${clipped}...`;
  }
  return lines;
}

/**
 * Stacks the code on a plate carrying its caption, and returns the plate.
 *
 * The code keeps its own quiet zone, so the caption starts below a full four modules of white and
 * cannot be read as part of the symbol.
 */
async function withCaption(
  code: HTMLCanvasElement,
  caption: QrCaption
): Promise<HTMLCanvasElement> {
  const width = code.width;
  const titlePx = Math.round(width * CAPTION_TITLE_SIZE_FRACTION);
  const subtitlePx = Math.round(width * CAPTION_SUBTITLE_SIZE_FRACTION);
  await loadCaptionFonts(titlePx, subtitlePx);

  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error('[qr] no 2D context to measure the caption');
  const maxWidth = width * (1 - 2 * CAPTION_SIDE_PADDING_FRACTION);

  measure.font = `700 ${titlePx}px ${CAPTION_TITLE_FONT}`;
  const titleLines = wrapText(measure, caption.title, maxWidth, CAPTION_MAX_TITLE_LINES);
  measure.font = `600 ${subtitlePx}px ${CAPTION_SUBTITLE_FONT}`;
  const subtitleLines = caption.subtitle ? wrapText(measure, caption.subtitle, maxWidth, 1) : [];

  const titleHeight = titleLines.length * titlePx * CAPTION_LINE_HEIGHT;
  const subtitleHeight = subtitleLines.length * subtitlePx * CAPTION_LINE_HEIGHT;
  const bottom = width * CAPTION_BOTTOM_PADDING_FRACTION;
  const plate = document.createElement('canvas');
  plate.width = width;
  plate.height = Math.round(code.height + titleHeight + subtitleHeight + bottom);

  const ctx = plate.getContext('2d');
  if (!ctx) throw new Error('[qr] no 2D context for the plate');
  ctx.fillStyle = QR_LIGHT_COLOR;
  ctx.fillRect(0, 0, plate.width, plate.height);
  ctx.drawImage(code, 0, 0);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  let baseline = code.height;
  ctx.fillStyle = QR_CAPTION_TITLE_COLOR;
  ctx.font = `700 ${titlePx}px ${CAPTION_TITLE_FONT}`;
  for (const line of titleLines) {
    baseline += titlePx * CAPTION_LINE_HEIGHT;
    ctx.fillText(line, width / 2, baseline);
  }
  ctx.fillStyle = QR_CAPTION_SUBTITLE_COLOR;
  ctx.font = `600 ${subtitlePx}px ${CAPTION_SUBTITLE_FONT}`;
  for (const line of subtitleLines) {
    baseline += subtitlePx * CAPTION_LINE_HEIGHT;
    ctx.fillText(line, width / 2, baseline);
  }

  console.debug(
    `[qr] caption on ${plate.width}x${plate.height}: ${titleLines.length} title line(s), ${subtitleLines.length} subtitle line(s)`
  );
  return plate;
}

/**
 * Renders `text` as a badged QR code on a plate naming what it opens.
 *
 * @param text - What the code encodes; a public absolute URL at every current call site.
 * @param caption - What the plate says under the code: the thing's name, and who is behind it.
 * @param targetPx - Pixel side aimed for by the CODE. Its canvas is the largest whole-module
 *   square that fits inside it, so it is usually a little smaller - never resampled. The plate is
 *   that width and taller.
 * @throws When a 2D context or the bird cannot be obtained.
 */
export async function renderQrCanvas(
  text: string,
  caption: QrCaption,
  targetPx: number = QR_EXPORT_TARGET_PX
): Promise<HTMLCanvasElement> {
  const symbol = await qrSymbol(text);
  const totalModules = symbol.modules.size + 2 * QR_QUIET_ZONE_MODULES;
  const modulePx = Math.max(1, Math.floor(targetPx / totalModules));
  const canvasPx = modulePx * totalModules;
  console.debug(
    `[qr] version ${symbol.version}, ${symbol.modules.size} modules, ${modulePx}px each -> ${canvasPx}px`
  );

  const canvas = document.createElement('canvas');
  canvas.width = canvasPx;
  canvas.height = canvasPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[qr] no 2D context');

  drawModules(ctx, symbol, modulePx, canvasPx);
  drawBadge(ctx, symbol, await loadLogo(), modulePx);
  return withCaption(canvas, caption);
}

/** {@link renderQrCanvas} as PNG bytes, for both the preview and the download. */
export async function renderQrPng(
  text: string,
  caption: QrCaption,
  targetPx: number = QR_EXPORT_TARGET_PX
): Promise<Blob> {
  const canvas = await renderQrCanvas(text, caption, targetPx);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('[qr] canvas produced no PNG'));
    }, 'image/png');
  });
}

/**
 * File name offered for the download: `canari-qr-<slug>.png`.
 *
 * A label that slugs to nothing - punctuation only, or an alphabet this transliteration does not
 * cover - still gets a usable name rather than a bare extension.
 */
export function qrFileName(label: string): string {
  const slug = slugify(label, 48);
  return slug ? `canari-qr-${slug}.png` : 'canari-qr.png';
}
