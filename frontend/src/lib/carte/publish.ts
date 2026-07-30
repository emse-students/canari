/**
 * Builds the artefact Canari publishes to the portail-etu showcase from the editor's live state.
 *
 * The published document is NOT the editor's layout. Three deliberate differences, each removing a
 * coupling between the two repos:
 *
 * 1. **Normalized geometry.** Everything is a fraction of the poster frame, so the showcase renders
 *    into a box of any width as long as it honours `aspectRatio`. The stage constants stay here.
 * 2. **Resolved silhouettes.** Shape keys are looked up here and travel as plain CSS
 *    `border-radius` values, so the showcase needs no copy of the shape catalog.
 * 3. **Blob box, not unit box.** A unit on the poster is the blob plus a bureau crown and president
 *    card; the showcase renders only the blob, so that is what gets published.
 *
 * Content is deliberately absent: a bubble carries `assoId` and nothing else about the association,
 * because the showcase joins it against the public association list. A rename, a new logo or a
 * changed brand color therefore reaches the published map with no republish - the same rule that
 * makes the editor re-resolve content on every open.
 *
 * The server re-validates everything built here (`published-carte.ts`) before serving it publicly.
 */

import {
  STAGE_WIDTH,
  STAGE_HEIGHT,
  UNIT_CX,
  BLOB_CY,
  BLOB_SIZE,
  TEXT_BASE_WIDTH,
  TEXT_BASE_SIZE,
  type PositionedBubble,
  type Decoration,
} from './layout';
import { shapeRadius, logoShape } from './shapes';

/** One association blob on the published map. Placement only; the consumer joins the content. */
export interface PublishedCarteBubble {
  /** Association id; the consumer's join key into `GET /api/public/associations`. */
  assoId: string;
  /** Blob left edge, as a fraction of the frame width. */
  x: number;
  /** Blob top edge, as a fraction of the frame height. */
  y: number;
  /** Blob diameter, as a fraction of the frame width. */
  w: number;
  /** Stacking order; higher renders on top. */
  z: number;
  /** Author's color override (hex), or null to use the association's live brand color. */
  color: string | null;
  /** Blob silhouette as a CSS `border-radius`, already resolved from the shape catalog. */
  radius: string;
  /** Logo frame as a CSS `border-radius`, already resolved from the logo-shape catalog. */
  logoRadius: string;
}

/** A free-text label on the published map. */
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

/** The full publication payload sent to `POST /api/associations/poster/:id/publish`. */
export interface PublishedCarte {
  /** Frame width / height; the consumer must render into a box of this ratio or the map skews. */
  aspectRatio: number;
  background: { dataUrl: string | null; scrimOpacity: number };
  /** Poster title color (hex), or null to let the consumer pick. */
  titleColor: string | null;
  bubbles: PublishedCarteBubble[];
  texts: PublishedCarteText[];
}

/** Rounds to 5 decimals: enough precision for a 1600px frame, without a wall of float noise. */
function frac(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/**
 * Converts the editor's live state into the published document.
 *
 * @param bubbles - Hand-placed association units, in poster pixel coordinates.
 * @param decorations - Free-form decorations; only text labels are published.
 * @param background - The editor's background image + scrim.
 * @param titleColor - The author's title color override, when set.
 */
export function buildPublishedCarte(
  bubbles: PositionedBubble[],
  decorations: Decoration[],
  background: { dataUrl: string | null; scrimOpacity: number },
  titleColor: string | null
): PublishedCarte {
  return {
    aspectRatio: frac(STAGE_WIDTH / STAGE_HEIGHT),
    background: { dataUrl: background.dataUrl, scrimOpacity: background.scrimOpacity },
    titleColor,
    // The blob sits centered inside its unit box, so its own top-left is the unit's origin plus
    // the (scaled) offset of the blob within the unit.
    bubbles: bubbles.map((b) => ({
      assoId: b.assoId,
      x: frac((b.x + (UNIT_CX - BLOB_SIZE / 2) * b.scale) / STAGE_WIDTH),
      y: frac((b.y + (BLOB_CY - BLOB_SIZE / 2) * b.scale) / STAGE_HEIGHT),
      w: frac((BLOB_SIZE * b.scale) / STAGE_WIDTH),
      z: b.z,
      color: b.colorOverride,
      radius: shapeRadius(b.shape),
      logoRadius: logoShape(b.logoShape).radius,
    })),
    texts: decorations
      .filter((d): d is Extract<Decoration, { kind: 'text' }> => d.kind === 'text')
      .filter((d) => d.content.trim().length > 0)
      .map((d) => ({
        x: frac(d.x / STAGE_WIDTH),
        y: frac(d.y / STAGE_HEIGHT),
        w: frac((TEXT_BASE_WIDTH * d.scale) / STAGE_WIDTH),
        z: d.z,
        size: frac((TEXT_BASE_SIZE * d.scale) / STAGE_WIDTH),
        content: d.content,
        color: d.color,
        bold: d.bold,
        align: d.align,
      })),
  };
}
