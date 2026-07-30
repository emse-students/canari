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

/** Length-based font size (px) for the association name inside the blob, so long names shrink. */
export function assoNameFontSize(name: string): number {
  const n = name.length;
  if (n <= 10) return 20.7;
  if (n <= 16) return 17.25;
  if (n <= 22) return 14.95;
  if (n <= 30) return 12.65;
  return 11.5;
}

/** Font size (px) of the contact-email line under the association name. */
export function assoEmailFontSize(name: string): number {
  return Math.max(5, assoNameFontSize(name) * 0.35);
}

// ── Member cards (poster px, scale 1) ───────────────────────────────────────────────────

/** Which slot a member card occupies: the crown over the blob, or the president at its bottom. */
export type MemberSlot = 'bureau' | 'president';

/** Base card width for each slot, before any widening. */
export const BUREAU_CARD_WIDTH = 64;
export const PRES_CARD_WIDTH = 73;
/** Padding inside a card, summed over both sides: the text box is the card minus this. */
export const CARD_PAD_X = 12;
/** Name font size (px) a short name gets, per slot. Every longer name steps down from here. */
const BUREAU_NAME_BASE = 6.4;
const PRES_NAME_BASE = 8.6;
/** Role size, as a fraction of the resolved name size, and its readable floor (px). */
const ROLE_RATIO = 0.88;
const MIN_ROLE_SIZE = 6;
/** Smallest name font (px) a card shrinks to for an over-wide word before it widens instead. */
const MIN_NAME_SIZE = 6.2;
/** Most a card may widen past its base width (x base) to fit a word that cannot be broken. */
const MAX_CARD_GROWTH = 1.4;
/**
 * Usable fraction of the text box. The estimate below is not exact, and the evidence that it must
 * err on the safe side is a real name: "Elliot WAGHEMACKER" broke in two at a size a 3% optimistic
 * estimate called a fit.
 */
const FIT_MARGIN = 0.95;

/** Step down the name size as a full name gets longer, because it then needs more lines. */
function nameLengthPenalty(length: number): number {
  if (length <= 10) return 0;
  if (length <= 16) return 0.9;
  if (length <= 22) return 1.8;
  if (length <= 30) return 2.6;
  return 3.4;
}

/**
 * Rough advance width of a string in em at font-weight 700 Nunito, by character class. Deliberately
 * crude and slightly pessimistic: the caller only needs to know whether a word overflows its card,
 * and over-estimating costs a hair of font size while under-estimating breaks the word in two.
 */
function textWidthEm(text: string): number {
  let em = 0;
  for (const ch of text) {
    if ('IiJjlt1.,:;\'"|!'.includes(ch)) em += 0.34;
    else if ('MWmw'.includes(ch)) em += 0.95;
    else if (ch !== ch.toLowerCase()) em += 0.75;
    else em += 0.58;
  }
  return em;
}

/** Width (em) of the widest run that cannot be broken: names wrap on spaces and hyphens only. */
function widestWordEm(name: string): number {
  let widest = 1;
  for (const word of name.split(/[\s-]+/)) widest = Math.max(widest, textWidthEm(word));
  return widest;
}

/** A member card's resolved box and text sizes; one call describes the whole card. */
export interface MemberCardMetrics {
  /** Card width. Grown past the slot's base width only for a name that cannot wrap into it. */
  w: number;
  /** The slot's base width: what the card is anchored on vertically, so widening moves nothing. */
  base: number;
  /** Photo side. Pinned to the BASE width, so a widened card keeps the same face size as its peers. */
  photo: number;
  /** Name / role font sizes. */
  nameSize: number;
  roleSize: number;
}

/**
 * Sizes one member card so the member's name actually fits it.
 *
 * Three steps, in order, because they answer different problems: a long full name wraps over more
 * lines (so it starts smaller), a single long surname cannot wrap at all (so it shrinks until it
 * fits one line), and past a floor shrinking further would be unreadable (so the card widens
 * instead). Cards are centered on their slot, so the extra width grows symmetrically.
 *
 * Shared with the publisher, which resolves these numbers into the published map - see `publish.ts`.
 */
export function memberCardMetrics(name: string, slot: MemberSlot): MemberCardMetrics {
  const isPresident = slot === 'president';
  const baseW = isPresident ? PRES_CARD_WIDTH : BUREAU_CARD_WIDTH;
  const textBox = (baseW - CARD_PAD_X) * FIT_MARGIN;

  let nameSize = (isPresident ? PRES_NAME_BASE : BUREAU_NAME_BASE) - nameLengthPenalty(name.length);
  const widest = widestWordEm(name);
  // Shrink to the size that fits the widest unbreakable word, but never below the floor - and never
  // UP, since the length ladder above may already have gone lower than the floor for a long name.
  const fitted = textBox / widest;
  if (fitted < nameSize) nameSize = Math.max(fitted, Math.min(nameSize, MIN_NAME_SIZE));

  const needed = (widest * nameSize) / FIT_MARGIN + CARD_PAD_X;
  return {
    w: round2(Math.min(baseW * MAX_CARD_GROWTH, Math.max(baseW, needed))),
    base: baseW,
    photo: baseW - CARD_PAD_X,
    nameSize: round2(nameSize),
    // The role labels the name and is never larger than it, with a floor so a card shrunk by a long
    // name does not also print an illegible role.
    roleSize: round2(Math.min(nameSize, Math.max(MIN_ROLE_SIZE, nameSize * ROLE_RATIO))),
  };
}

/** Rounds to 2 decimals: sub-pixel accuracy without a wall of float noise in the payload. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
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

// ── Bureau crown (poster px) ────────────────────────────────────────────────────────────
// The ellipse the bureau cards are fanned over, hand-tuned against the printed poster. These were
// live sliders in a debug panel while the composition was being found; the panel is gone and the
// values are final, so they are plain constants - the publisher resolves them for the showcase.

/** Crown center Y within the unit box. */
export const BUREAU_CROWN_CY = 147;
/** Ellipse horizontal radius (narrower than the vertical one, so the crown hugs the blob). */
export const BUREAU_CROWN_RX = 119;
/** Ellipse vertical radius. */
export const BUREAU_CROWN_RY = 147;
/** Angle (rad) of each slot level, from the lowest pair to the highest. */
const CROWN_ANGLES = [-0.85, -0.11, 0.57];

/**
 * Crown offset for the bureau card at `index`, along the top half of an ellipse. Slots are filled
 * in mirrored pairs from the bottom up, leaving the center free for the president card below.
 */
export function bureauCrownOffset(index: number): { x: number; y: number } {
  const level = Math.min(Math.floor(index / 2), CROWN_ANGLES.length - 1);
  const side = index % 2 === 0 ? -1 : 1;
  const baseAngle = CROWN_ANGLES[level];
  const angle = side < 0 ? Math.PI - baseAngle : baseAngle;
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
