import type { PosterModel, PosterBubble, PosterMemberRef } from './generator';
import {
  DEFAULT_SHAPE,
  isShapeKey,
  getRandomShape,
  DEFAULT_LOGO_SHAPE,
  isLogoShapeKey,
} from './shapes';

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
  /** List of user IDs manually selected to be displayed in the bureau crown. */
  selectedBureau?: string[];
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
/**
 * Horizontal center of a unit box; the blob, the logo and the bureau arc are all centered on it.
 * Lives here rather than in the renderer because the publisher needs the blob's box too (it is the
 * only part of a unit the published map carries - see `publish.ts`).
 */
export const UNIT_CX = CARD_WIDTH / 2;
/** Vertical center of the colored association blob within its unit box (poster px, scale 1). */
export const BLOB_CY = 172;
/** Diameter of the colored association blob (poster px, scale 1). */
export const BLOB_SIZE = 210;

// ── Unit internals (poster px, scale 1) ─────────────────────────────────────────────────
// The layers of one association unit, back to front: the colored blob; the hero logo centered on
// it (its own shape, allowed to overflow); the bureau member cards fanned over the blob's TOP arc;
// the president card overlapping the blob bottom; and the association name in a band inside the
// blob below the logo (so a long name wraps + shrinks instead of being clipped).
//
// These live here rather than in `PosterCanvas.svelte` because the PUBLISHER needs the exact same
// numbers: the showcase draws a copy of this unit from resolved geometry instead of re-deriving
// proportions of its own, so any constant the renderer uses has to be reachable from `publish.ts`.

/** Base logo size (px); the logo shape scales this by its w/h ratio and may overflow the blob. */
export const LOGO_BASE = 92;
/** Logo center Y: upper part of the blob, so the association name fits inside below it. */
export const LOGO_CY = BLOB_CY - 38;
/** Font size of the initials shown behind a missing logo. */
export const LOGO_INITIALS_SIZE = 36;
/** Association-name box top (inside the blob, below the logo). */
export const NAME_TOP = BLOB_CY + 12;
/** Horizontal inset of the name box inside the blob (total, both sides). */
export const NAME_INSET = 56;
/** President card top: below the logo + name, hanging off the blob's bottom rim. */
export const PRES_TOP = BLOB_CY + 74;
/** Max bureau cards fanned over the blob's top arc (6 + the president = 7 members shown). */
export const MAX_BUREAU = 6;
/** Base name font size for a bureau card, before the tuning scale. */
export const BUREAU_NAME_BASE = 8.8;
/** Base name font size for the president card (a touch larger), before the tuning scale. */
export const PRES_NAME_BASE = 10.8;

/** Length-based font size (px) for the association name inside the blob, so long names shrink. */
export function nameFontSize(name: string): number {
  const n = name.length;
  if (n <= 10) return 18;
  if (n <= 16) return 15;
  if (n <= 22) return 13;
  if (n <= 30) return 11;
  return 10;
}

/** Length- and width-based name font size (px) for a member card (bureau / president), which wraps. */
export function cardNameFontSize(name: string, cardW: number, base: number): number {
  const n = name.length;
  const widthPenalty = cardW <= 70 ? 1.1 : cardW <= 85 ? 0.6 : 0;
  if (n <= 10) return base - widthPenalty;
  if (n <= 16) return base - 0.9 - widthPenalty;
  if (n <= 22) return base - 1.8 - widthPenalty;
  if (n <= 30) return base - 2.6 - widthPenalty;
  return base - 3.4 - widthPenalty;
}

/** Role font size (px) on a member card, derived from its name base. */
export function cardRoleFontSize(nameBase: number, tuning: CarteDebugTuning): number {
  return Math.max((nameBase - 2.5) * tuning.memberRoleScale, 6.8);
}

/**
 * Picks the members a unit actually shows: the first one is drawn as the president card at the
 * blob's bottom, the next {@link MAX_BUREAU} fan out over its top arc. An explicit
 * {@link PositionedBubble.selectedBureau} wins; otherwise the association's admins are used.
 *
 * Shared with the publisher so the showcase shows the same faces in the same slots as the poster.
 */
export function resolveUnitMembers(
  bubble: Pick<PositionedBubble, 'selectedBureau'>,
  members: PosterMemberRef[]
): { president: PosterMemberRef | null; bureau: PosterMemberRef[] } {
  const selected = bubble.selectedBureau ? new Set(bubble.selectedBureau) : null;
  const visible = selected
    ? members.filter((mem) => selected.has(mem.userId))
    : members.filter((mem) => mem.isAdmin);
  return { president: visible[0] ?? null, bureau: visible.slice(1, 1 + MAX_BUREAU) };
}

// ── Poster title band (poster px) ────────────────────────────────────────────────────────

/** Stage side padding shared by the title and the seed grid, also offered as an alignment guide. */
export const CONTENT_MARGIN = 48;
/** Title baseline box top. */
export const TITLE_TOP = 36;
/** Title font size. */
export const TITLE_SIZE = 52;

/** Right edge available to bubbles; the directory column is reserved on the right when shown. */
export function bubbleLimit(directoryVisible: boolean): number {
  return directoryVisible ? STAGE_WIDTH - DIRECTORY_WIDTH : STAGE_WIDTH;
}

/** The title box in poster px. It spans the bubble region, so it shrinks when the directory shows. */
export function titleRect(directoryVisible: boolean): { x: number; y: number; w: number } {
  return {
    x: CONTENT_MARGIN,
    y: TITLE_TOP,
    w: bubbleLimit(directoryVisible) - 2 * CONTENT_MARGIN,
  };
}

// ── Right-hand directory panel (poster px) ──────────────────────────────────────────────
// Same reason as the unit internals: the publisher resolves the panel for the showcase.

/** Inset of the directory panel from the frame's top / right / bottom edges. */
export const DIRECTORY_INSET = 48;
/** Rounded corner of the directory panel. */
export const DIRECTORY_RADIUS = 20;
/** Vertical / horizontal padding inside the directory panel. */
export const DIRECTORY_PAD_Y = 24;
export const DIRECTORY_PAD_X = 26;
/** Directory heading ("Annuaire") font size. */
export const DIRECTORY_HEADING_SIZE = 24;
/** Base body font size; the renderer shrinks from here until the whole roster fits the column. */
export const DIRECTORY_BASE_FONT = 13;
/** Column count + gutter of the directory's multi-column body. */
export const DIRECTORY_COLUMNS = 2;
export const DIRECTORY_COLUMN_GAP = 24;

/** The directory panel's box in poster px. Fixed, so both the renderer and the publisher use it. */
export function directoryRect(): { x: number; y: number; w: number; h: number } {
  const w = DIRECTORY_WIDTH - 2 * DIRECTORY_INSET;
  return {
    x: STAGE_WIDTH - DIRECTORY_INSET - w,
    y: DIRECTORY_INSET,
    w,
    h: STAGE_HEIGHT - 2 * DIRECTORY_INSET,
  };
}

/** Base (scale 1) width of a free-text decoration box (used for wrapping + resize math). */
export const TEXT_BASE_WIDTH = 320;
/** Base (scale 1) font size of a free-text decoration in poster px. */
export const TEXT_BASE_SIZE = 34;

/** Runtime tuning knobs exposed in the carte debug panel. */
export interface CarteDebugTuning {
  bureauCrownCy: number;
  bureauCrownRx: number;
  bureauCrownRy: number;
  bureauCrownAngle1: number;
  bureauCrownAngle2: number;
  bureauCrownAngle3: number;
  bureauCardWidth: number;
  presidentCardWidth: number;
  associationNameScale: number;
  memberNameScale: number;
  memberRoleScale: number;
}

/** Default values used when no debug tuning is active. */
export const DEFAULT_CARTE_DEBUG_TUNING: CarteDebugTuning = {
  bureauCrownCy: 147,
  bureauCrownRx: 119,
  bureauCrownRy: 147,
  bureauCrownAngle1: -0.85,
  bureauCrownAngle2: -0.11,
  bureauCrownAngle3: 0.57,
  bureauCardWidth: 64,
  presidentCardWidth: 73,
  associationNameScale: 1.15,
  memberNameScale: 0.88,
  memberRoleScale: 0.9,
};

/** Crown center Y for bureau cards: same center as the previous circle. */
export const BUREAU_CROWN_CY = DEFAULT_CARTE_DEBUG_TUNING.bureauCrownCy;
/** Ellipse horizontal radius for bureau cards (narrower than the vertical radius). */
export const BUREAU_CROWN_RX = DEFAULT_CARTE_DEBUG_TUNING.bureauCrownRx;
/** Ellipse vertical radius for bureau cards: same size as the previous circle radius. */
export const BUREAU_CROWN_RY = DEFAULT_CARTE_DEBUG_TUNING.bureauCrownRy;

/**
 * Returns the crown offset for a bureau card along the top half of an ellipse.
 * Slots start near the sides and move upward, while the center remains empty for the president.
 */
export function bureauCrownOffset(index: number, total: number): { x: number; y: number } {
  return bureauCrownOffsetWithTuning(index, total, DEFAULT_CARTE_DEBUG_TUNING);
}

/** Crown offset helper that accepts runtime tuning. */
export function bureauCrownOffsetWithTuning(
  index: number,
  total: number, // not used anymore but kept for signature compatibility
  tuning: CarteDebugTuning
): { x: number; y: number } {
  const level = Math.floor(index / 2); // 0, 1, 2
  const side = index % 2 === 0 ? -1 : 1;

  let baseAngle = tuning.bureauCrownAngle1 || -0.1;
  if (level === 1) baseAngle = tuning.bureauCrownAngle2 || 0.6;
  if (level >= 2) baseAngle = tuning.bureauCrownAngle3 || 1.2;

  const angle = side < 0 ? Math.PI - baseAngle : baseAngle;

  return {
    x: tuning.bureauCrownRx * Math.cos(angle),
    y: -tuning.bureauCrownRy * Math.sin(angle),
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
        shape: getRandomShape(),
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
      selectedBureau: Array.isArray(prev.selectedBureau) ? prev.selectedBureau : undefined,
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
