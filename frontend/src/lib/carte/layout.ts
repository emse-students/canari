import type { PosterModel, PosterBubble } from './generator';
import { DEFAULT_SHAPE, isShapeKey, DEFAULT_LOGO_SHAPE, isLogoShapeKey } from './shapes';

/**
 * A single association placed on the freeform poster canvas. Positions are stored in the
 * poster's natural pixel space ({@link STAGE_WIDTH} wide), independent of the on-screen preview
 * scale, so a saved layout renders identically at any zoom. Only placement + per-bubble visual
 * overrides live here; the association's content (name, logo, president, bureau) is re-resolved
 * from live data on every open and looked up by {@link PositionedBubble.assoId}.
 */
export interface PositionedBubble {
  /** Association id this unit renders (key into the resolved content map). */
  assoId: string;
  /** Unit top-left X in poster coordinates (px, 0..{@link STAGE_WIDTH}). */
  x: number;
  /** Unit top-left Y in poster coordinates (px). */
  y: number;
  /** Uniform unit scale (1 = natural {@link CARD_WIDTH}px unit). Resized via the corner handles. */
  scale: number;
  /** Stacking order; higher renders on top. */
  z: number;
  /** Overrides the resolved brand color when set (hex), else the live color is used. */
  colorOverride: string | null;
  /** Whether the president is shown inside this association's blob. */
  showPresident: boolean;
  /** Blob silhouette key (see {@link CARTE_SHAPES}); falls back to the default when unknown. */
  shape: string;
  /** Logo frame shape key (see {@link LOGO_SHAPES}); falls back to the default when unknown. */
  logoShape: string;
}

/**
 * Fixed natural width of the poster stage; the export captures at this size. The stage is a fixed
 * A2 landscape frame ({@link STAGE_WIDTH} x {@link STAGE_HEIGHT}, ratio SQRT2), so the export fills
 * a standard A2 page with no distortion and no white bar.
 */
export const STAGE_WIDTH = 1600;
/** Fixed natural height of the A2 landscape frame: STAGE_WIDTH / SQRT2 (A-series aspect). */
export const STAGE_HEIGHT = Math.round(STAGE_WIDTH / Math.SQRT2);
/** Width of the right-hand directory column (poster px); bubbles are confined to the left of it. */
export const DIRECTORY_WIDTH = 500;
/** Base (scale 1) width of an association blob unit (blob + the bureau arc + the name band). */
export const CARD_WIDTH = 400;
/**
 * Base (scale 1) height of an association blob unit: the blob + bureau arc live in the upper part
 * and the (wrapping) association name sits in a band below, so the unit is taller than it is wide.
 */
export const CARD_HEIGHT = 430;
/** Base (scale 1) width of a free-text decoration box (used for wrapping + resize math). */
export const TEXT_BASE_WIDTH = 320;
/** Base (scale 1) font size of a free-text decoration in poster px. */
export const TEXT_BASE_SIZE = 34;
/** Crown center Y for bureau cards: same center as the previous circle. */
export const BUREAU_CROWN_CY = 118;
/** Ellipse horizontal radius for bureau cards (narrower than the vertical radius). */
export const BUREAU_CROWN_RX = 132;
/** Ellipse vertical radius for bureau cards: same size as the previous circle radius. */
export const BUREAU_CROWN_RY = 180;
/** Angular gap around the center slot so the president stays unobstructed. */
export const BUREAU_CROWN_CENTER_GAP = Math.PI / 10;

/**
 * Returns the crown offset for a bureau card along the top half of an ellipse.
 * Slots start near the sides and move upward, while the center remains empty for the president.
 */
export function bureauCrownOffset(index: number, total: number): { x: number; y: number } {
  const level = Math.floor(index / 2);
  const pairCount = Math.max(1, Math.ceil(total / 2));
  const progress = pairCount === 1 ? 0 : level / (pairCount - 1);
  const side = index % 2 === 0 ? -1 : 1;
  const angle =
    side < 0
      ? Math.PI - progress * (Math.PI / 2 - BUREAU_CROWN_CENTER_GAP)
      : progress * (Math.PI / 2 - BUREAU_CROWN_CENTER_GAP);
  return {
    x: BUREAU_CROWN_RX * Math.cos(angle),
    y: -BUREAU_CROWN_RY * Math.sin(angle),
  };
}

// Seed-grid geometry (poster px). Kept here so the editor can recompute resets.
const MARGIN = 48;
/** Reserved band at the top for the title before the first bubble row. */
const TITLE_BAND = 150;
const GAP_X = 18;
const ROW_GAP = 18;
/** Extra vertical gap inserted between two category groups in the seed grid. */
const ZONE_GAP = 14;
/** Smallest / largest scale the auto-fit is allowed to seed at. */
const SEED_MIN_SCALE = 0.2;
const SEED_MAX_SCALE = 0.6;

/** Left region width available for bubbles (the directory column is reserved on the right). */
function bubbleRegionWidth(width: number): number {
  return width - DIRECTORY_WIDTH;
}

/** Columns that fit across the left region at a given unit scale. */
function columnCount(width: number, scale: number): number {
  const step = CARD_WIDTH * scale + GAP_X;
  return Math.max(1, Math.floor((bubbleRegionWidth(width) - 2 * MARGIN + GAP_X) / step));
}

/** Total seed-grid height (poster px) the whole model would occupy at a given unit scale. */
function seedGridHeight(model: PosterModel, width: number, scale: number): number {
  const cols = columnCount(width, scale);
  const stepY = CARD_HEIGHT * scale + ROW_GAP;
  let rows = 0;
  for (const zone of model.zones) rows += Math.max(1, Math.ceil(zone.bubbles.length / cols));
  const gaps = Math.max(0, model.zones.length - 1) * ZONE_GAP;
  return TITLE_BAND + rows * stepY + gaps;
}

/**
 * Largest unit scale (within [{@link SEED_MIN_SCALE}, {@link SEED_MAX_SCALE}]) at which the whole
 * roster still fits inside the fixed A2 frame, so a fresh project never seeds bubbles off-frame
 * (the frame clips overflow, which otherwise made assos "disappear"). The author resizes from there.
 */
function fitSeedScale(model: PosterModel, width: number): number {
  const limit = STAGE_HEIGHT - MARGIN;
  for (let s = SEED_MAX_SCALE; s > SEED_MIN_SCALE; s -= 0.02) {
    if (seedGridHeight(model, width, s) <= limit) return Math.round(s * 100) / 100;
  }
  return SEED_MIN_SCALE;
}

/**
 * Produces a deterministic starting grid for every bubble in the model, confined to the left
 * region (the directory column is reserved on the right): each category zone starts on a fresh row
 * and its bubbles wrap left-to-right at an auto-fitted scale so the whole roster fits the A2 frame.
 * z is the insertion order so later units sit on top by default.
 */
export function seedBubbleLayout(
  model: PosterModel,
  width: number = STAGE_WIDTH
): PositionedBubble[] {
  const scale = fitSeedScale(model, width);
  const cols = columnCount(width, scale);
  const stepX = CARD_WIDTH * scale + GAP_X;
  const stepY = CARD_HEIGHT * scale + ROW_GAP;
  const out: PositionedBubble[] = [];
  let y = TITLE_BAND;

  for (const zone of model.zones) {
    let col = 0;
    for (const bubble of zone.bubbles) {
      if (col === cols) {
        col = 0;
        y += stepY;
      }
      out.push({
        assoId: bubble.assoId,
        x: MARGIN + col * stepX,
        y,
        scale,
        z: out.length + 1,
        colorOverride: null,
        showPresident: true,
        shape: DEFAULT_SHAPE,
        logoShape: DEFAULT_LOGO_SHAPE,
      });
      col++;
    }
    // Advance past the current zone's last row, plus a gap before the next zone.
    y += stepY + ZONE_GAP;
  }

  return out;
}

/**
 * Reconciles a persisted layout with the current live model: every bubble present in the model
 * gets a position (its saved one when the asso still exists, else a fresh seed slot), and saved
 * entries for associations that no longer exist are dropped. Keeps hand-placed positions stable
 * across reopens while absorbing newly-created / archived associations.
 *
 * @param saved - Positions from `project.layout.bubbles` (may be empty on first open).
 * @param model - Freshly-built poster model (source of truth for which bubbles exist).
 */
export function mergeBubbleLayout(
  saved: PositionedBubble[],
  model: PosterModel
): PositionedBubble[] {
  const savedById = new Map(saved.map((b) => [b.assoId, b]));
  return seedBubbleLayout(model).map((seed) => {
    const prev = savedById.get(seed.assoId);
    if (!prev) return seed;
    const scale = typeof prev.scale === 'number' && prev.scale > 0 ? prev.scale : seed.scale;
    // Clamp saved positions back inside the A2 frame so a legacy layout saved against the old
    // (taller) stage never leaves a unit off-frame where overflow:hidden would clip it away.
    const maxX = Math.max(0, STAGE_WIDTH - DIRECTORY_WIDTH - CARD_WIDTH * scale);
    const maxY = Math.max(0, STAGE_HEIGHT - CARD_HEIGHT * scale);
    const rawX = typeof prev.x === 'number' ? prev.x : seed.x;
    const rawY = typeof prev.y === 'number' ? prev.y : seed.y;
    return {
      assoId: seed.assoId,
      x: Math.min(Math.max(0, rawX), maxX),
      y: Math.min(Math.max(0, rawY), maxY),
      scale,
      z: typeof prev.z === 'number' ? prev.z : seed.z,
      colorOverride: typeof prev.colorOverride === 'string' ? prev.colorOverride : null,
      showPresident: prev.showPresident !== false,
      shape: typeof prev.shape === 'string' && isShapeKey(prev.shape) ? prev.shape : DEFAULT_SHAPE,
      logoShape:
        typeof prev.logoShape === 'string' && isLogoShapeKey(prev.logoShape)
          ? prev.logoShape
          : DEFAULT_LOGO_SHAPE,
    };
  });
}

/** Flattens the zoned model into a lookup of resolved content keyed by association id. */
export function indexBubbleContent(model: PosterModel): Record<string, PosterBubble> {
  const map: Record<string, PosterBubble> = {};
  for (const zone of model.zones) {
    for (const bubble of zone.bubbles) map[bubble.assoId] = bubble;
  }
  return map;
}

// ── Free-form decorations (free text) ───────────────────────────────────────────────────
// Decorations are pure canvas ornaments: unlike bubbles they carry their own content and are not
// tied to live association data, so they need no merge step - only a defensive parse on load.

/** Placement fields shared by every decoration. Positions are in poster coordinates (px). */
interface DecorationBase {
  /** Stable, client-generated unique id. */
  id: string;
  /** Top-left X in poster coordinates (px). */
  x: number;
  /** Top-left Y in poster coordinates (px). */
  y: number;
  /** Uniform scale (1 = natural size). Resized via the corner handles. */
  scale: number;
  /** Stacking order; higher renders on top. */
  z: number;
}

/** A free-text label the author can drag, resize, restyle and edit. */
export interface TextDecoration extends DecorationBase {
  kind: 'text';
  /** Rendered text; may contain line breaks. */
  content: string;
  /** Text color (hex). */
  color: string;
  /** Whether the text is bold. */
  bold: boolean;
  /** Horizontal alignment inside the box. */
  align: 'left' | 'center' | 'right';
}

/** Any placeable decoration. Currently just a free-text label. */
export type Decoration = TextDecoration;

/** Builds a new empty text decoration at the given poster coordinates. */
export function createTextDecoration(
  x: number,
  y: number,
  z: number,
  color: string
): TextDecoration {
  return {
    id: crypto.randomUUID(),
    kind: 'text',
    x,
    y,
    scale: 1,
    z,
    content: '',
    color,
    bold: true,
    align: 'center',
  };
}

/** Defensively parses persisted decorations, dropping anything malformed or of an unknown kind. */
export function sanitizeDecorations(raw: unknown): Decoration[] {
  if (!Array.isArray(raw)) return [];
  const out: Decoration[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string') continue;
    // Placement fields are shared by every kind; parse them once.
    const base = {
      id: r.id,
      x: typeof r.x === 'number' ? r.x : 0,
      y: typeof r.y === 'number' ? r.y : 0,
      scale: typeof r.scale === 'number' && r.scale > 0 ? r.scale : 1,
      z: typeof r.z === 'number' ? r.z : 1,
    };
    if (r.kind === 'text') {
      out.push({
        ...base,
        kind: 'text',
        content: typeof r.content === 'string' ? r.content : '',
        color: typeof r.color === 'string' ? r.color : '#ffffff',
        bold: r.bold !== false,
        align: r.align === 'left' || r.align === 'right' ? r.align : 'center',
      });
    }
  }
  return out;
}
