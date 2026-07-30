/**
 * The "Carte de la Vie Asso" PUBLISHED contract - the artefact Canari hands to the portail-etu
 * showcase, and the only carte shape that ever leaves this service unauthenticated.
 *
 * It is deliberately NOT the editor's `layout` document:
 *
 * - **Normalized geometry.** Positions are fractions of the poster frame, never pixels, so the
 *   consumer renders into a box of any size as long as it honours {@link PublishedCarte.aspectRatio}.
 *   Neither side has to know the editor's stage constants.
 * - **Resolved appearance.** Silhouettes arrive as plain CSS `border-radius` values, already looked
 *   up from Canari's shape catalog by the publisher, so the consumer needs no copy of that catalog.
 * - **No content.** A bubble carries only `assoId`; the consumer joins it against
 *   `GET /api/public/associations` for the name, logo and brand color. A renamed association
 *   therefore updates the published map with no republish, exactly like the editor re-resolves
 *   content on every open.
 *
 * Because a published map is served to anonymous visitors and its numbers/strings are interpolated
 * straight into the consumer's `style` attributes, the document is re-validated field by field on
 * the way in ({@link sanitizePublishedCarte}) rather than stored as an opaque blob. See
 * docs/wiki/carte-vie-asso.md, "Publishing to the Portail".
 */

/** Current publication schema version. Bumped only on a breaking change to the shape below. */
export const PUBLISHED_CARTE_VERSION = 1;

/** One association placed on the published map. Placement only - the content is joined by the consumer. */
export interface PublishedCarteBubble {
  /** Association id; the consumer's join key into the public association list. */
  assoId: string;
  /** Left edge, as a fraction of the frame width. */
  x: number;
  /** Top edge, as a fraction of the frame height. */
  y: number;
  /** Unit width, as a fraction of the frame width. */
  w: number;
  /** Stacking order; higher renders on top. */
  z: number;
  /** Author's brand-color override (hex), or null to use the association's live color. */
  color: string | null;
  /** Blob silhouette as a CSS `border-radius` value, resolved from the shape catalog at publish. */
  radius: string;
  /** Logo frame as a CSS `border-radius` value, resolved from the logo-shape catalog at publish. */
  logoRadius: string;
}

/** A free-text label placed on the published map. */
export interface PublishedCarteText {
  /** Left edge, as a fraction of the frame width. */
  x: number;
  /** Top edge, as a fraction of the frame height. */
  y: number;
  /** Box width, as a fraction of the frame width. */
  w: number;
  /** Stacking order; higher renders on top. */
  z: number;
  /** Font size, as a fraction of the frame width. */
  size: number;
  content: string;
  /** Text color (hex). */
  color: string;
  bold: boolean;
  align: 'left' | 'center' | 'right';
}

/** A poster published to the public showcase. */
export interface PublishedCarte {
  version: number;
  /** Frame width / height. The consumer must render into a box of this ratio or the map skews. */
  aspectRatio: number;
  /** Background image (data URL) and its legibility scrim, mirroring the editor's chrome. */
  background: { dataUrl: string | null; scrimOpacity: number };
  /** Poster title color (hex), or null to let the consumer pick. */
  titleColor: string | null;
  bubbles: PublishedCarteBubble[];
  texts: PublishedCarteText[];
}

/**
 * Caps. These bound the size of a payload that is served publicly and uncached-by-default; they are
 * generous enough that no legitimate poster hits them.
 */
const MAX_BUBBLES = 400;
const MAX_TEXTS = 200;
const MAX_TEXT_LENGTH = 1000;
const MAX_ASSO_ID_LENGTH = 64;
const MAX_RADIUS_LENGTH = 96;
/** ~6 MB of base64, i.e. a background image of roughly 4.5 MB. */
const MAX_DATA_URL_LENGTH = 6_000_000;

/** Default silhouette used when a radius fails validation, so a bad shape degrades to a circle. */
const FALLBACK_RADIUS = '50%';

/**
 * A CSS `border-radius` shorthand and nothing else. The published value is interpolated into a
 * `style` attribute by the consumer, so anything outside digits, `%`, `.`, `/` and spaces - which
 * is everything needed to express a radius - is rejected rather than escaped.
 */
const RADIUS_PATTERN = /^[0-9%./ ]+$/;

/** A CSS hex color (`#rgb` through `#rrggbbaa`). */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;

/** Returns `value` clamped into [min, max], or `fallback` when it is not a finite number. */
function num(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/** Returns a validated hex color, or null. */
function hex(value: unknown): string | null {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value) ? value : null;
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

/** Validates one bubble, returning null when it carries no usable association reference. */
function toBubble(raw: unknown): PublishedCarteBubble | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.assoId !== 'string' || !r.assoId || r.assoId.length > MAX_ASSO_ID_LENGTH) {
    return null;
  }
  return {
    assoId: r.assoId,
    // Positions may sit slightly outside the frame (the consumer clips), but stay bounded.
    x: num(r.x, -1, 2, 0),
    y: num(r.y, -1, 2, 0),
    w: num(r.w, 0.001, 1, 0.1),
    z: num(r.z, 0, 10_000, 1),
    color: hex(r.color),
    radius: radius(r.radius),
    logoRadius: radius(r.logoRadius),
  };
}

/** Validates one free-text label, returning null when it has nothing to render. */
function toText(raw: unknown): PublishedCarteText | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const content = typeof r.content === 'string' ? r.content.slice(0, MAX_TEXT_LENGTH) : '';
  if (!content.trim()) return null;
  return {
    x: num(r.x, -1, 2, 0),
    y: num(r.y, -1, 2, 0),
    w: num(r.w, 0.001, 2, 0.2),
    z: num(r.z, 0, 10_000, 1),
    size: num(r.size, 0.001, 0.5, 0.02),
    content,
    color: hex(r.color) ?? '#ffffff',
    bold: r.bold !== false,
    align: r.align === 'left' || r.align === 'right' ? r.align : 'center',
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

  const bubbles: PublishedCarteBubble[] = [];
  if (Array.isArray(r.bubbles)) {
    for (const item of r.bubbles.slice(0, MAX_BUBBLES)) {
      const bubble = toBubble(item);
      if (bubble) bubbles.push(bubble);
    }
  }
  // A map with no association is not a map - refuse rather than publish a blank frame.
  if (bubbles.length === 0) return null;

  const texts: PublishedCarteText[] = [];
  if (Array.isArray(r.texts)) {
    for (const item of r.texts.slice(0, MAX_TEXTS)) {
      const text = toText(item);
      if (text) texts.push(text);
    }
  }

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
    background: { dataUrl, scrimOpacity: Math.round(num(rawBg.scrimOpacity, 0, 100, 0)) },
    titleColor: hex(r.titleColor),
    bubbles,
    texts,
  };
}
