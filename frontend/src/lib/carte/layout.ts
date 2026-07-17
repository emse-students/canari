import type { PosterModel, PosterBubble } from './generator';

/**
 * A single association placed on the freeform poster canvas. Positions are stored in the
 * poster's natural pixel space ({@link STAGE_WIDTH} wide), independent of the on-screen preview
 * scale, so a saved layout renders identically at any zoom. Only placement + per-bubble visual
 * overrides live here; the association's content (name, logo, president) is re-resolved from live
 * data on every open and looked up by {@link PositionedBubble.assoId}.
 */
export interface PositionedBubble {
  /** Association id this card renders (key into the resolved content map). */
  assoId: string;
  /** Card top-left X in poster coordinates (px, 0..{@link STAGE_WIDTH}). */
  x: number;
  /** Card top-left Y in poster coordinates (px). */
  y: number;
  /** Uniform card scale (1 = natural {@link CARD_WIDTH}px card). Resized via the corner handles. */
  scale: number;
  /** Stacking order; higher renders on top. */
  z: number;
  /** Overrides the resolved brand color when set (hex), else the live color is used. */
  colorOverride: string | null;
  /** Whether the president polaroid is shown under this bubble. */
  showPresident: boolean;
}

/** Fixed natural width of the poster stage; the export captures at this size. */
export const STAGE_WIDTH = 1600;
/** Base (scale 1) width of a bubble card column. Matches the P1 static column width. */
export const CARD_WIDTH = 190;
/** Base (scale 1) width of a free-text decoration box (used for wrapping + resize math). */
export const TEXT_BASE_WIDTH = 320;
/** Base (scale 1) font size of a free-text decoration in poster px. */
export const TEXT_BASE_SIZE = 34;
/** Base (scale 1) side of a square doodle box (used for rendering + resize math). */
export const DOODLE_BASE_SIZE = 120;
/** Base (scale 1) side of a square background-blob box (used for rendering + resize math). */
export const BLOB_BASE_SIZE = 280;

// Seed-grid geometry (poster px). Kept here so the editor can recompute stage height + resets.
const MARGIN = 56;
/** Reserved band at the top for the title + subtitle before the first bubble row. */
const TITLE_BAND = 132;
/** Nominal card height (disc + name + polaroid) used only to space seed rows without overlap. */
const NOMINAL_CARD_HEIGHT = 300;
const GAP_X = 24;
const ROW_GAP = 28;
/** Extra vertical gap inserted between two category groups in the seed grid. */
const ZONE_GAP = 24;

/** Columns that fit across the stage at scale 1. */
function columnCount(width: number): number {
  return Math.max(1, Math.floor((width - 2 * MARGIN + GAP_X) / (CARD_WIDTH + GAP_X)));
}

/**
 * Produces a deterministic starting grid for every bubble in the model: each category zone starts
 * on a fresh row and its bubbles wrap left-to-right. This is the P1 look as a starting point - the
 * author then hand-arranges from here (design doc: "auto-layout is a starting grid, not the final
 * look"). z is the insertion order so later cards sit on top by default.
 */
export function seedBubbleLayout(
  model: PosterModel,
  width: number = STAGE_WIDTH
): PositionedBubble[] {
  const cols = columnCount(width);
  const out: PositionedBubble[] = [];
  let y = TITLE_BAND;

  for (const zone of model.zones) {
    let col = 0;
    for (const bubble of zone.bubbles) {
      if (col === cols) {
        col = 0;
        y += NOMINAL_CARD_HEIGHT + ROW_GAP;
      }
      out.push({
        assoId: bubble.assoId,
        x: MARGIN + col * (CARD_WIDTH + GAP_X),
        y,
        scale: 1,
        z: out.length + 1,
        colorOverride: null,
        showPresident: true,
      });
      col++;
    }
    // Advance past the current zone's last row, plus a gap before the next zone.
    y += NOMINAL_CARD_HEIGHT + ROW_GAP + ZONE_GAP;
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
    return {
      assoId: seed.assoId,
      x: typeof prev.x === 'number' ? prev.x : seed.x,
      y: typeof prev.y === 'number' ? prev.y : seed.y,
      scale: typeof prev.scale === 'number' && prev.scale > 0 ? prev.scale : 1,
      z: typeof prev.z === 'number' ? prev.z : seed.z,
      colorOverride: typeof prev.colorOverride === 'string' ? prev.colorOverride : null,
      showPresident: prev.showPresident !== false,
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

/**
 * Computes the stage height needed to contain every placed bubble AND decoration (with bottom
 * margin), never shorter than the seed grid. Uses generous per-element upper bounds so tall
 * (president-bearing) cards or multi-line texts are not clipped.
 */
export function stageHeight(bubbles: PositionedBubble[], decorations: Decoration[] = []): number {
  let bottom = TITLE_BAND + NOMINAL_CARD_HEIGHT;
  for (const b of bubbles) {
    bottom = Math.max(bottom, b.y + b.scale * NOMINAL_CARD_HEIGHT);
  }
  for (const d of decorations) {
    // Rough per-decoration lower bound at the element's scale (a few text lines / one doodle or blob box).
    const extent =
      d.kind === 'doodle'
        ? DOODLE_BASE_SIZE
        : d.kind === 'blob'
          ? BLOB_BASE_SIZE
          : TEXT_BASE_SIZE * 4;
    bottom = Math.max(bottom, d.y + d.scale * extent);
  }
  return Math.ceil(bottom + MARGIN);
}

// ── Free-form decorations (text, doodles, background blobs) ─────────────────────────────
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

/** A decorative shape (rendered as an inline lucide SVG) the author can drag, resize and recolor. */
export interface DoodleDecoration extends DecorationBase {
  kind: 'doodle';
  /** Shape key into the doodle catalog (see `doodles.ts`). */
  shape: string;
  /** Fill/stroke color (hex). */
  color: string;
}

/** A soft organic background shape (CSS border-radius blob) the author can drag, resize and recolor. */
export interface BlobDecoration extends DecorationBase {
  kind: 'blob';
  /** Shape key into the blob catalog (see `blobs.ts`). */
  shape: string;
  /** Fill color (hex). */
  color: string;
  /** Fill opacity (0-100), so a blob can wash behind bubbles without hiding them. */
  opacity: number;
}

/** Any placeable decoration: a text label, a doodle icon, or a background blob. */
export type Decoration = TextDecoration | DoodleDecoration | BlobDecoration;

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

/** Builds a new doodle decoration for the given shape at the given poster coordinates. */
export function createDoodleDecoration(
  shape: string,
  x: number,
  y: number,
  z: number,
  color: string
): DoodleDecoration {
  return { id: crypto.randomUUID(), kind: 'doodle', x, y, scale: 1, z, shape, color };
}

/** Builds a new background blob for the given shape at the given poster coordinates. */
export function createBlobDecoration(
  shape: string,
  x: number,
  y: number,
  z: number,
  color: string
): BlobDecoration {
  return { id: crypto.randomUUID(), kind: 'blob', x, y, scale: 1, z, shape, color, opacity: 50 };
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
    } else if (r.kind === 'doodle' && typeof r.shape === 'string') {
      out.push({
        ...base,
        kind: 'doodle',
        shape: r.shape,
        color: typeof r.color === 'string' ? r.color : '#ffffff',
      });
    } else if (r.kind === 'blob' && typeof r.shape === 'string') {
      out.push({
        ...base,
        kind: 'blob',
        shape: r.shape,
        color: typeof r.color === 'string' ? r.color : '#ffffff',
        opacity: typeof r.opacity === 'number' ? r.opacity : 50,
      });
    }
  }
  return out;
}
