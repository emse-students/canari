/**
 * Builds the artefact Canari publishes to the portail-etu showcase from the editor's live state.
 *
 * The published document is a **resolved poster**, not the editor's layout and not a rendering: it
 * carries every box and every font size the poster draws, already computed, so the showcase can
 * reproduce the map exactly instead of re-deriving proportions of its own.
 *
 * Three properties make that work:
 *
 * 1. **One coordinate space.** Everything below is in POSTER pixels against the published
 *    {@link PublishedCarte.stage}. The showcase renders a `stage.w x stage.h` box scaled once
 *    (`frameWidth / stage.w`), so every number here is used verbatim - no unit conversion, hence no
 *    class of "the portal drew it 8% too small" bug. It also makes the directory's shrink-to-fit
 *    measure the same pixels on both sides.
 * 2. **Resolved geometry.** Shape keys, the bureau crown ellipse, the length-based font ladders and
 *    the per-card widening are all applied HERE. The showcase needs no copy of the catalogs and no
 *    copy of the layout math, so a geometry change reaches the live map by republishing alone.
 * 3. **Association content stays live, people are a snapshot.** A unit carries `assoId` only, so a
 *    rename, a new logo or a new brand color needs no republish (`colorFallback` covers an
 *    association that has no color of its own). Members are the opposite: WHICH member appears in
 *    which crown slot is an authoring decision, so the displayed cards and the directory lines are
 *    frozen at publish time - a roster change needs a republish, by design.
 *
 * The server re-validates every field of this (`published-carte.ts`) before serving it publicly.
 */

import type { CarteStyle } from './theme';
import { orderByFamilyName } from './generator';
import type { PosterBubble, PosterModel } from './generator';
import { getInitials } from '$lib/utils/avatar';
import {
  STAGE_WIDTH,
  STAGE_HEIGHT,
  UNIT_CX,
  BLOB_CY,
  BLOB_SIZE,
  CARD_WIDTH,
  CARD_HEIGHT,
  LOGO_BASE,
  LOGO_CY,
  LOGO_INITIALS_SIZE,
  NAME_TOP,
  NAME_INSET,
  PRES_TOP,
  BUREAU_CROWN_CY,
  BUREAU_CARD_WIDTH,
  TEXT_BASE_WIDTH,
  TEXT_BASE_SIZE,
  TITLE_SIZE,
  DIRECTORY_RADIUS,
  DIRECTORY_PAD_X,
  DIRECTORY_PAD_Y,
  DIRECTORY_HEADING_SIZE,
  DIRECTORY_BASE_FONT,
  DIRECTORY_COLUMNS,
  DIRECTORY_COLUMN_GAP,
  directoryRect,
  titleRect,
  bureauCrownOffset,
  assoNameFontSize,
  assoEmailFontSize,
  memberCardMetrics,
  resolveUnitMembers,
  type MemberSlot,
  type PositionedBubble,
  type Decoration,
} from './layout';
import { shapeRadius, logoShape } from './shapes';

/** The poster frame every coordinate in this document is expressed against (poster px). */
export interface PublishedCarteStage {
  w: number;
  h: number;
}

/** The poster's resolved palette, so a restyle in Canari needs no showcase deploy. */
export interface PublishedCarteStyle {
  /** Page background, painted under the optional background image. */
  pageBg: string;
  /** Scrim drawn over the background image. */
  scrimColor: string;
  /** Member-card background + caption color. */
  cardBg: string;
  cardTextColor: string;
  /** Directory panel background + its primary / secondary text colors. */
  directoryBg: string;
  directoryTextColor: string;
  directoryMutedColor: string;
}

/** A positioned run of text: the poster title, or one of the author's free-text labels. */
export interface PublishedCarteText {
  /** Box left edge / top edge, in poster px. */
  x: number;
  y: number;
  /** Box width, in poster px. Text wraps inside it. */
  w: number;
  /** Stacking order; higher renders on top. Always 0 for the title (it sits under the units). */
  z: number;
  /** Font size in poster px. */
  size: number;
  /** CSS font weight (the poster uses 500 / 700 / 800). */
  weight: number;
  content: string;
  /** Text color. */
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
  /** Initials shown while / if the photo does not load. Resolved here so both sides agree. */
  initials: string;
  /** Card box, in poster px relative to the unit's top-left (before the unit scale). */
  x: number;
  y: number;
  /** Card width. Wider than its peers' when the name holds a word that cannot be broken. */
  w: number;
  /**
   * Photo side, in poster px. Published rather than derived from `w`, because a widened card keeps
   * the same face size as the cards around it - deriving it would enlarge one member's photo.
   */
  photo: number;
  /** Name / role font sizes, in poster px. */
  nameSize: number;
  roleSize: number;
}

/** One association unit: the blob, its logo, its name band and the member cards around it. */
export interface PublishedCarteUnit {
  /** Association id; the showcase's join key into `GET /api/public/associations`. */
  assoId: string;
  /** Unit top-left on the stage, in poster px. */
  x: number;
  y: number;
  /** Unit box at scale 1, in poster px. This is the link's hit area once scaled. */
  w: number;
  h: number;
  /** Author's unit scale. Everything inside is at scale 1, so the whole box scales as one. */
  scale: number;
  /** Stacking order; higher renders on top. */
  z: number;
  /** Author's color override, or null to use the association's live brand color. */
  color: string | null;
  /** Color the poster resolved, used when the association carries none of its own. */
  colorFallback: string;
  /** The colored silhouette, unit-relative poster px. */
  blob: { x: number; y: number; size: number; radius: string };
  /** The hero logo frame (may overflow the blob), unit-relative poster px. */
  logo: {
    x: number;
    y: number;
    w: number;
    h: number;
    radius: string;
    /** Font size + text of the initials shown when the association has no logo. */
    initialsSize: number;
    initials: string;
  };
  /** The association-name band inside the blob, unit-relative poster px. */
  name: {
    x: number;
    y: number;
    w: number;
    size: number;
    /** Font size of the contact-email line under the name (the address itself is joined live). */
    emailSize: number;
  };
  /** President + bureau cards, in render order (bureau first, then the president in front). */
  cards: PublishedCarteCard[];
}

/** One association's line in the directory: the color dot + name are joined, the roster is frozen. */
export interface PublishedCarteDirectoryAsso {
  /** Join key for the displayed name and color dot. */
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
  /** Panel box on the stage, in poster px (border-box: the padding is inside it). */
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  padX: number;
  padY: number;
  heading: string;
  headingSize: number;
  /**
   * Base body font size in poster px. The renderer shrinks DOWN from here until the roster fits
   * the fixed panel - a measurement, not a constant, which is why it is not resolved here: both
   * sides run the same loop over the same poster pixels and land on the same size.
   */
  fontSize: number;
  columns: number;
  columnGap: number;
  zones: PublishedCarteDirectoryZone[];
}

/** The full publication payload sent to `POST /api/associations/poster/:id/publish`. */
export interface PublishedCarte {
  /** Frame width / height; the consumer must render into a box of this ratio or the map skews. */
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

/** Rounds a poster-pixel value to 2 decimals: sub-pixel accuracy without a wall of float noise. */
function px(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Resolves one member into the card the poster draws: `memberCardMetrics` sizes it (a name holding
 * an unbreakable word widens the card), and the slot decides where that box is anchored.
 */
function toCard(
  member: { userId: string; name: string; role: string },
  slot: MemberSlot,
  anchor: { cx: number; y: number }
): PublishedCarteCard {
  const card = memberCardMetrics(member.name, slot);
  return {
    userId: member.userId,
    name: member.name,
    role: member.role,
    initials: getInitials(member.name),
    // Centered on its anchor, so widening grows the card sideways instead of shifting it.
    x: px(anchor.cx - card.w / 2),
    y: px(anchor.y),
    w: card.w,
    photo: card.photo,
    nameSize: card.nameSize,
    roleSize: card.roleSize,
  };
}

/**
 * Resolves one association unit: the blob, the logo frame, the name band and the member cards,
 * with the crown ellipse and the card sizing already applied.
 */
function toUnit(bubble: PositionedBubble, data: PosterBubble): PublishedCarteUnit {
  const shown = resolveUnitMembers(bubble, data.members);
  const ls = logoShape(bubble.logoShape);
  const lw = LOGO_BASE * ls.w;
  const lh = LOGO_BASE * ls.h;
  const nameW = BLOB_SIZE - NAME_INSET;

  // Bureau first, then the president: the poster draws them in that order so the president's card
  // sits in front of the crown, and the showcase renders the array as it comes.
  const cards = shown.bureau.map((member, i) => {
    const offset = bureauCrownOffset(i);
    return toCard(member, 'bureau', {
      cx: UNIT_CX + offset.x,
      // Anchored on the base width, like the editor: a widened card must not leave the ellipse.
      y: BUREAU_CROWN_CY + offset.y - BUREAU_CARD_WIDTH / 2,
    });
  });
  if (shown.president) {
    cards.push(toCard(shown.president, 'president', { cx: UNIT_CX, y: PRES_TOP }));
  }

  return {
    assoId: bubble.assoId,
    x: px(bubble.x),
    y: px(bubble.y),
    w: CARD_WIDTH,
    h: CARD_HEIGHT,
    scale: bubble.scale,
    z: bubble.z,
    color: bubble.colorOverride,
    colorFallback: data.color,
    blob: {
      x: px(UNIT_CX - BLOB_SIZE / 2),
      y: px(BLOB_CY - BLOB_SIZE / 2),
      size: BLOB_SIZE,
      radius: shapeRadius(bubble.shape),
    },
    logo: {
      x: px(UNIT_CX - lw / 2),
      y: px(LOGO_CY - lh / 2),
      w: px(lw),
      h: px(lh),
      radius: ls.radius,
      initialsSize: LOGO_INITIALS_SIZE,
      initials: getInitials(data.name),
    },
    name: {
      x: px(UNIT_CX - nameW / 2),
      y: NAME_TOP,
      w: nameW,
      size: px(assoNameFontSize(data.name)),
      emailSize: px(assoEmailFontSize(data.name)),
    },
    cards,
  };
}

/** Formats one association's roster exactly as the directory prints it. */
function directoryLine(asso: PosterBubble): string {
  return orderByFamilyName(asso.members)
    .map((mem) => (mem.role ? `${mem.name} (${mem.role})` : mem.name))
    .join(' - ');
}

/**
 * Converts the editor's live state into the published document.
 *
 * @param params.bubbles - Hand-placed association units, in poster pixel coordinates.
 * @param params.content - Resolved association content, keyed by association id.
 * @param params.model - The zoned model, which is what the directory lists.
 * @param params.decorations - Free-form decorations; only text labels are published.
 * @param params.background - The editor's background image + scrim.
 * @param params.style - The poster style, with the author's title color already applied.
 * @param params.title - The project name, drawn as the poster's title.
 * @param params.directoryVisible - Whether the author shows the right-hand directory.
 * @param params.directoryHeading - Localized directory heading, resolved by the caller.
 */
export function buildPublishedCarte(params: {
  bubbles: PositionedBubble[];
  content: Record<string, PosterBubble>;
  model: PosterModel;
  decorations: Decoration[];
  background: { dataUrl: string | null; scrimOpacity: number };
  style: CarteStyle;
  title: string;
  directoryVisible: boolean;
  directoryHeading: string;
}): PublishedCarte {
  const { style } = params;
  const t = titleRect(params.directoryVisible);
  const dir = directoryRect();

  return {
    aspectRatio: Math.round((STAGE_WIDTH / STAGE_HEIGHT) * 1e5) / 1e5,
    stage: { w: STAGE_WIDTH, h: STAGE_HEIGHT },
    background: { ...params.background },
    style: {
      pageBg: style.pageBg,
      scrimColor: style.scrimColor,
      cardBg: style.polaroidBg,
      cardTextColor: style.polaroidTextColor,
      directoryBg: style.directoryBg,
      directoryTextColor: style.directoryTextColor,
      directoryMutedColor: style.directoryMutedColor,
    },
    // The title sits under everything (the units carry z >= 1), like the editor's title band.
    title: params.title.trim()
      ? {
          x: t.x,
          y: t.y,
          w: t.w,
          z: 0,
          size: TITLE_SIZE,
          weight: 700,
          content: params.title,
          color: style.titleColor,
          align: 'left',
        }
      : null,
    units: params.bubbles
      .filter((bubble) => params.content[bubble.assoId])
      .map((bubble) => toUnit(bubble, params.content[bubble.assoId])),
    texts: params.decorations
      .filter((d): d is Extract<Decoration, { kind: 'text' }> => d.kind === 'text')
      .filter((d) => d.content.trim().length > 0)
      .map((d) => ({
        x: px(d.x),
        y: px(d.y),
        w: px(TEXT_BASE_WIDTH * d.scale),
        z: d.z,
        size: px(TEXT_BASE_SIZE * d.scale),
        weight: d.bold ? 800 : 500,
        content: d.content,
        color: d.color,
        align: d.align,
      })),
    directory: params.directoryVisible
      ? {
          x: dir.x,
          y: dir.y,
          w: dir.w,
          h: dir.h,
          radius: DIRECTORY_RADIUS,
          padX: DIRECTORY_PAD_X,
          padY: DIRECTORY_PAD_Y,
          heading: params.directoryHeading,
          headingSize: DIRECTORY_HEADING_SIZE,
          fontSize: DIRECTORY_BASE_FONT,
          columns: DIRECTORY_COLUMNS,
          columnGap: DIRECTORY_COLUMN_GAP,
          zones: params.model.zones
            .filter((zone) => zone.bubbles.length > 0)
            .map((zone) => ({
              label: zone.label,
              assos: zone.bubbles.map((asso) => ({
                assoId: asso.assoId,
                line: directoryLine(asso),
              })),
            })),
        }
      : null,
  };
}
