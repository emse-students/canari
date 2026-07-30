/**
 * The "Carte de la Vie Asso" PUBLISHED contract - the artefact Canari hands to the portail-etu
 * showcase, and the only carte shape that ever leaves this service unauthenticated.
 *
 * It is deliberately NOT the editor's `layout` document, and not a rendering either: it is the
 * poster **resolved**. Every box, every font size and every silhouette the poster draws is computed
 * by the publisher, so the showcase reproduces the map exactly instead of re-deriving proportions of
 * its own (which is what v1 did, and it could only ever be an approximation).
 *
 * - **One coordinate space.** All geometry is in POSTER pixels against {@link PublishedCarte.stage}.
 *   The consumer renders a `stage.w x stage.h` box scaled once, so every number here is used
 *   verbatim. (v1 used fractions of the frame, which forced the consumer to reinvent every size it
 *   was not given - see docs/wiki/carte-vie-asso.md.)
 * - **Resolved appearance.** Shape keys, the bureau crown ellipse, the length-based font ladders and
 *   the author's geometry tuning are already applied. The consumer holds no catalog and no layout
 *   math.
 * - **Association content is joined live, people are a snapshot.** A unit carries `assoId` only, so
 *   a rename or a new logo needs no republish. WHICH members appear in which crown slot is an
 *   authoring decision, so the cards and the directory lines are frozen at publish time.
 *
 * Because a published map is served to anonymous visitors and its numbers and colors are
 * interpolated straight into the consumer's `style` attributes, the document is re-validated field
 * by field on the way in ({@link sanitizePublishedCarte}) rather than stored as an opaque blob.
 */

/**
 * Current publication schema version.
 *
 * **2** is the resolved-poster document below. A stored v1 payload (fractions of the frame, a
 * `bubbles` array, no members and no directory) is NOT upgradable here - the members and the
 * geometry it lacks only exist in the editor, next to live association data - so the showcase
 * ignores anything without `units` and the author republishes once. Losing a `publication` costs a
 * click; the poster itself lives in `layout`, which this change does not touch.
 */
export const PUBLISHED_CARTE_VERSION = 2;

/** The poster frame every coordinate in this document is expressed against (poster px). */
export interface PublishedCarteStage {
  w: number;
  h: number;
}

/** The poster's resolved palette, so a restyle in Canari needs no showcase deploy. */
export interface PublishedCarteStyle {
  pageBg: string;
  scrimColor: string;
  cardBg: string;
  cardTextColor: string;
  directoryBg: string;
  directoryTextColor: string;
  directoryMutedColor: string;
}

/** A positioned run of text: the poster title, or one of the author's free-text labels. */
export interface PublishedCarteText {
  /** Box left / top edge, in poster px. */
  x: number;
  y: number;
  /** Box width, in poster px; text wraps inside it. */
  w: number;
  /** Stacking order; higher renders on top. */
  z: number;
  /** Font size, in poster px. */
  size: number;
  /** CSS font weight. */
  weight: number;
  content: string;
  color: string;
  align: 'left' | 'center' | 'right';
}

/** A member card (president or bureau) drawn on a unit: square photo + name + optional role. */
export interface PublishedCarteCard {
  /** Avatar join key; the showcase fetches the photo through its own same-origin proxy. */
  userId: string;
  name: string;
  /** Role line under the name, or '' when the member has none. */
  role: string;
  /** Initials shown when the photo does not load. */
  initials: string;
  /** Card box, in poster px relative to the unit's top-left (before the unit scale). */
  x: number;
  y: number;
  w: number;
  nameSize: number;
  roleSize: number;
}

/** One association unit: the blob, its logo, its name band and the member cards around it. */
export interface PublishedCarteUnit {
  /** Association id; the consumer's join key into the public association list. */
  assoId: string;
  /** Unit top-left on the stage, in poster px. */
  x: number;
  y: number;
  /** Unit box at scale 1, in poster px. */
  w: number;
  h: number;
  /** Author's unit scale; the whole box scales as one. */
  scale: number;
  z: number;
  /** Author's color override, or null to use the association's live brand color. */
  color: string | null;
  /** Color the poster resolved, used when the association carries none of its own. */
  colorFallback: string;
  blob: { x: number; y: number; size: number; radius: string };
  logo: {
    x: number;
    y: number;
    w: number;
    h: number;
    radius: string;
    initialsSize: number;
    initials: string;
  };
  name: { x: number; y: number; w: number; size: number; emailSize: number };
  /** President + bureau cards, in render order. */
  cards: PublishedCarteCard[];
}

/** One association's line in the directory. */
export interface PublishedCarteDirectoryAsso {
  assoId: string;
  /** The roster as the poster prints it: "Name (Role) - Name - ...", alphabetical. */
  line: string;
}

/** A category section of the directory. */
export interface PublishedCarteDirectoryZone {
  label: string;
  assos: PublishedCarteDirectoryAsso[];
}

/** The right-hand member directory ("annuaire"), resolved. */
export interface PublishedCarteDirectory {
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  padX: number;
  padY: number;
  heading: string;
  headingSize: number;
  /** Base body font size (poster px); the renderer shrinks from here until the roster fits. */
  fontSize: number;
  columns: number;
  columnGap: number;
  zones: PublishedCarteDirectoryZone[];
}

/** A poster published to the public showcase. */
export interface PublishedCarte {
  version: number;
  /** Frame width / height. The consumer must render into a box of this ratio or the map skews. */
  aspectRatio: number;
  stage: PublishedCarteStage;
  background: { dataUrl: string | null; scrimOpacity: number };
  style: PublishedCarteStyle;
  /** The poster's own title band, or null when the project has no name. */
  title: PublishedCarteText | null;
  units: PublishedCarteUnit[];
  texts: PublishedCarteText[];
  /** The member directory, or null when the author hid it. */
  directory: PublishedCarteDirectory | null;
}

/**
 * Caps. These bound the size of a payload that is served publicly; they are generous enough that no
 * legitimate poster hits them. The per-unit card cap mirrors the poster's own limit (6 bureau
 * members plus the president).
 */
const MAX_UNITS = 400;
const MAX_CARDS_PER_UNIT = 12;
const MAX_TEXTS = 200;
const MAX_TEXT_LENGTH = 1000;
const MAX_NAME_LENGTH = 200;
const MAX_LINE_LENGTH = 4000;
const MAX_ZONES = 40;
const MAX_ASSOS_PER_ZONE = 400;
const MAX_ID_LENGTH = 64;
const MAX_RADIUS_LENGTH = 96;
const MAX_COLOR_LENGTH = 64;
/** ~6 MB of base64, i.e. a background image of roughly 4.5 MB. */
const MAX_DATA_URL_LENGTH = 6_000_000;

/** Geometry bounds (poster px). Wide enough for any stage the editor can produce. */
const MAX_COORD = 20_000;
/** Font sizes are px in the same space; a poster never needs more. */
const MAX_FONT = 400;

/** Default silhouette used when a radius fails validation, so a bad shape degrades to a circle. */
const FALLBACK_RADIUS = '50%';
/** Default color when one fails validation: neutral, and obviously wrong to an author reviewing it. */
const FALLBACK_COLOR = '#888888';

/**
 * A CSS `border-radius` shorthand and nothing else. The published value is interpolated into a
 * `style` attribute by the consumer, so anything outside digits, `%`, `.`, `/` and spaces - which
 * is everything needed to express a radius - is rejected rather than escaped.
 */
const RADIUS_PATTERN = /^[0-9%./ ]+$/;

/** A CSS hex color (`#rgb` through `#rrggbbaa`). */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;

/**
 * A hex literal, or an `rgb()/rgba()/hsl()/hsla()` function with nothing but numbers and separators
 * inside. The poster's own palette is not all hex (the panel background is `rgba(...)`, an
 * association with no brand color falls back to `hsl(...)`), so those two forms are accepted - but
 * as a closed grammar, for the same reason as the radius above.
 */
const CSS_COLOR_PATTERN = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/-]+\))$/;

/** Returns `value` clamped into [min, max], or `fallback` when it is not a finite number. */
function num(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/** A poster-pixel coordinate (may be negative: an element can hang off the frame, which clips). */
function coord(value: unknown, fallback = 0): number {
  return num(value, -MAX_COORD, MAX_COORD, fallback);
}

/** A poster-pixel length or font size (never negative). */
function len(value: unknown, fallback: number, max = MAX_COORD): number {
  return num(value, 0, max, fallback);
}

/** Returns a validated hex color, or null. Used for the colors an author picks in the editor. */
function hex(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= MAX_COLOR_LENGTH &&
    HEX_COLOR_PATTERN.test(value)
    ? value
    : null;
}

/** Returns a validated CSS color (hex / rgb / hsl), or the neutral fallback. */
function cssColor(value: unknown, fallback = FALLBACK_COLOR): string {
  return typeof value === 'string' &&
    value.length <= MAX_COLOR_LENGTH &&
    CSS_COLOR_PATTERN.test(value)
    ? value
    : fallback;
}

/** Returns a validated CSS border-radius, or the circle fallback. */
function radius(value: unknown): string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_RADIUS_LENGTH &&
    RADIUS_PATTERN.test(value)
    ? value
    : FALLBACK_RADIUS;
}

/** Returns a trimmed, length-capped string. Text lands in a text node, so it is capped, not parsed. */
function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Returns a validated identifier (association id, user id), or null. */
function id(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
    ? value
    : null;
}

/** Validates one member card, returning null when it has no user to show. */
function toCard(raw: unknown): PublishedCarteCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const userId = id(r.userId);
  if (!userId) return null;
  return {
    userId,
    name: text(r.name, MAX_NAME_LENGTH),
    role: text(r.role, MAX_NAME_LENGTH),
    initials: text(r.initials, 4),
    x: coord(r.x),
    y: coord(r.y),
    w: len(r.w, 60),
    nameSize: len(r.nameSize, 9, MAX_FONT),
    roleSize: len(r.roleSize, 7, MAX_FONT),
  };
}

/** Validates one association unit, returning null when it carries no usable association reference. */
function toUnit(raw: unknown): PublishedCarteUnit | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const assoId = id(r.assoId);
  if (!assoId) return null;

  const rawBlob = (r.blob ?? {}) as Record<string, unknown>;
  const rawLogo = (r.logo ?? {}) as Record<string, unknown>;
  const rawName = (r.name ?? {}) as Record<string, unknown>;

  const cards: PublishedCarteCard[] = [];
  if (Array.isArray(r.cards)) {
    for (const item of r.cards.slice(0, MAX_CARDS_PER_UNIT)) {
      const card = toCard(item);
      if (card) cards.push(card);
    }
  }

  return {
    assoId,
    x: coord(r.x),
    y: coord(r.y),
    w: len(r.w, 400),
    h: len(r.h, 430),
    scale: num(r.scale, 0.01, 10, 1),
    z: num(r.z, 0, 10_000, 1),
    color: hex(r.color),
    colorFallback: cssColor(r.colorFallback),
    blob: {
      x: coord(rawBlob.x),
      y: coord(rawBlob.y),
      size: len(rawBlob.size, 210),
      radius: radius(rawBlob.radius),
    },
    logo: {
      x: coord(rawLogo.x),
      y: coord(rawLogo.y),
      w: len(rawLogo.w, 92),
      h: len(rawLogo.h, 92),
      radius: radius(rawLogo.radius),
      initialsSize: len(rawLogo.initialsSize, 36, MAX_FONT),
      initials: text(rawLogo.initials, 4),
    },
    name: {
      x: coord(rawName.x),
      y: coord(rawName.y),
      w: len(rawName.w, 154),
      size: len(rawName.size, 14, MAX_FONT),
      emailSize: len(rawName.emailSize, 5, MAX_FONT),
    },
    cards,
  };
}

/** Validates one run of text, returning null when it has nothing to render. */
function toText(raw: unknown): PublishedCarteText | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const content = text(r.content, MAX_TEXT_LENGTH);
  if (!content.trim()) return null;
  return {
    x: coord(r.x),
    y: coord(r.y),
    w: len(r.w, 320),
    z: num(r.z, 0, 10_000, 1),
    size: len(r.size, 34, MAX_FONT),
    weight: num(r.weight, 100, 900, 400),
    content,
    color: hex(r.color) ?? '#ffffff',
    align: r.align === 'left' || r.align === 'right' ? r.align : 'center',
  };
}

/** Validates the directory panel, returning null when the author published none. */
function toDirectory(raw: unknown): PublishedCarteDirectory | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const zones: PublishedCarteDirectoryZone[] = [];
  if (Array.isArray(r.zones)) {
    for (const item of r.zones.slice(0, MAX_ZONES)) {
      if (!item || typeof item !== 'object') continue;
      const z = item as Record<string, unknown>;
      const assos: PublishedCarteDirectoryAsso[] = [];
      if (Array.isArray(z.assos)) {
        for (const entry of z.assos.slice(0, MAX_ASSOS_PER_ZONE)) {
          if (!entry || typeof entry !== 'object') continue;
          const a = entry as Record<string, unknown>;
          const assoId = id(a.assoId);
          if (!assoId) continue;
          assos.push({ assoId, line: text(a.line, MAX_LINE_LENGTH) });
        }
      }
      zones.push({ label: text(z.label, MAX_NAME_LENGTH), assos });
    }
  }

  return {
    x: coord(r.x),
    y: coord(r.y),
    w: len(r.w, 404),
    h: len(r.h, 1035),
    radius: len(r.radius, 20, MAX_FONT),
    padX: len(r.padX, 26, MAX_FONT),
    padY: len(r.padY, 24, MAX_FONT),
    heading: text(r.heading, MAX_NAME_LENGTH),
    headingSize: len(r.headingSize, 24, MAX_FONT),
    fontSize: len(r.fontSize, 13, MAX_FONT),
    columns: Math.round(num(r.columns, 1, 6, 2)),
    columnGap: len(r.columnGap, 24, MAX_FONT),
    zones,
  };
}

/** Validates the resolved palette, falling back per field rather than dropping the whole block. */
function toStyle(raw: unknown): PublishedCarteStyle {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    pageBg: cssColor(r.pageBg, '#fdf3e3'),
    scrimColor: cssColor(r.scrimColor, '#3a2a12'),
    cardBg: cssColor(r.cardBg, '#ffffff'),
    cardTextColor: cssColor(r.cardTextColor, '#374151'),
    directoryBg: cssColor(r.directoryBg, 'rgba(255,255,255,0.86)'),
    directoryTextColor: cssColor(r.directoryTextColor, '#1f2937'),
    directoryMutedColor: cssColor(r.directoryMutedColor, '#6b7280'),
  };
}

/**
 * Validates a publication payload field by field, dropping anything malformed. Returns null when
 * the document is unusable (not an object, or no association left to place) so the caller can
 * refuse the publish instead of going live with an empty map.
 *
 * @param raw - The body sent by the carte editor. Never trusted, even though the caller is an admin.
 */
export function sanitizePublishedCarte(raw: unknown): PublishedCarte | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const units: PublishedCarteUnit[] = [];
  if (Array.isArray(r.units)) {
    for (const item of r.units.slice(0, MAX_UNITS)) {
      const unit = toUnit(item);
      if (unit) units.push(unit);
    }
  }
  // A map with no association is not a map - refuse rather than publish a blank frame.
  if (units.length === 0) return null;

  const texts: PublishedCarteText[] = [];
  if (Array.isArray(r.texts)) {
    for (const item of r.texts.slice(0, MAX_TEXTS)) {
      const item2 = toText(item);
      if (item2) texts.push(item2);
    }
  }

  const rawStage = (r.stage ?? {}) as Record<string, unknown>;
  const rawBg = (r.background ?? {}) as Record<string, unknown>;
  const dataUrl =
    typeof rawBg.dataUrl === 'string' &&
    rawBg.dataUrl.startsWith('data:image/') &&
    rawBg.dataUrl.length <= MAX_DATA_URL_LENGTH
      ? rawBg.dataUrl
      : null;

  return {
    version: PUBLISHED_CARTE_VERSION,
    aspectRatio: num(r.aspectRatio, 0.2, 5, Math.SQRT2),
    stage: { w: num(rawStage.w, 1, MAX_COORD, 1600), h: num(rawStage.h, 1, MAX_COORD, 1131) },
    background: { dataUrl, scrimOpacity: Math.round(num(rawBg.scrimOpacity, 0, 100, 0)) },
    style: toStyle(r.style),
    title: toText(r.title),
    units,
    texts,
    directory: toDirectory(r.directory),
  };
}
