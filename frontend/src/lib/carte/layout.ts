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

/**
 * Points one poster pixel is worth on the printed sheet.
 *
 * The poster is printed on A0 landscape and ONLY on A0 (decided 2026-09-27): 3370 pt of page for
 * {@link STAGE_WIDTH} poster px. Every readability floor in this file is stated in poster px and
 * derived through this number, so a floor can be read back as a size on paper.
 */
export const PT_PER_POSTER_PX = 3370 / STAGE_WIDTH;

/**
 * Smallest text the poster prints, in poster px: ~9.5 pt on A0.
 *
 * Measured on the published map on 2026-09-27: the smallest vector text in the exported PDF was
 * 4.4 pt (1.6 mm), which is not read at arm's length on a wall. Nothing drawn at a unit's own scale
 * may fall below this ONCE SCALED, which is why the helpers taking a floor also take the scale.
 */
export const MIN_POSTER_TEXT_PX = 4.5;

/**
 * Font size (px, at the unit's own scale) of the contact-email line under the association name.
 *
 * Five of the 31 associations set one, and at 0.35 x the name inside a unit scaled to 0.46 it
 * printed at ~3 pt - present, unreadable, and therefore worse than absent. It is raised to
 * {@link MIN_POSTER_TEXT_PX} on the SHEET, so the size grows as the unit shrinks. The address wraps
 * on any character, so the extra height stays inside the blob's name band.
 *
 * @param unitScale - The unit's scale; everything in a unit is drawn through it.
 */
export function assoEmailFontSize(name: string, unitScale = 1): number {
  const floor = MIN_POSTER_TEXT_PX / Math.max(unitScale, 0.01);
  return round2(Math.max(floor, assoNameFontSize(name) * 0.35));
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
 *
 * @param imposedNameSize - The size every card in the unit shares, from {@link fitUnitNameSize}.
 *   The per-name ladder above is then NOT consulted: it is what put "Thomas DELLESTABLE" at 4.6 px
 *   beside a neighbour at 6.4 px in one crown (user, D13). The card still widens for a word that
 *   cannot wrap into it, and still shrinks below the imposed size only when even the widened card
 *   cannot hold that word.
 */
export function memberCardMetrics(
  name: string,
  slot: MemberSlot,
  imposedNameSize?: number
): MemberCardMetrics {
  const isPresident = slot === 'president';
  const baseW = isPresident ? PRES_CARD_WIDTH : BUREAU_CARD_WIDTH;
  const widest = widestWordEm(name);

  let nameSize: number;
  if (imposedNameSize === undefined) {
    const textBox = (baseW - CARD_PAD_X) * FIT_MARGIN;
    nameSize = (isPresident ? PRES_NAME_BASE : BUREAU_NAME_BASE) - nameLengthPenalty(name.length);
    // Shrink to the size that fits the widest unbreakable word, but never below the floor - and
    // never UP, since the ladder above may already have gone lower than the floor for a long name.
    const fitted = textBox / widest;
    if (fitted < nameSize) nameSize = Math.max(fitted, Math.min(nameSize, MIN_NAME_SIZE));
  } else {
    // The widened card is the budget: below it the word genuinely cannot be drawn on one line.
    const widestBox = (baseW * MAX_CARD_GROWTH - CARD_PAD_X) * FIT_MARGIN;
    nameSize = Math.min(imposedNameSize, widestBox / widest);
  }

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

// The card's own box, as `PosterCanvas` writes it: padding, the gaps above the two text lines and
// their line heights. They live here because the height below is an estimate of THAT markup, and an
// estimate that drifts from the markup it describes reports overlaps that are not there.
const CARD_PAD_TOP = 6;
const CARD_PAD_BOTTOM = 7;
const NAME_GAP = 4;
const NAME_LINE_HEIGHT = 1.1;
const ROLE_GAP = 1;
const ROLE_LINE_HEIGHT = 1.05;

/**
 * Lines a string takes in a box, wrapping where the browser would: on spaces and hyphens.
 *
 * Greedy, like every line breaker, and fed by the same deliberately pessimistic {@link textWidthEm}
 * the card sizing uses - so it over-counts rather than under-counts, and a unit's estimated box is
 * never smaller than what is drawn in it.
 */
function wrappedLineCount(text: string, fontSize: number, boxWidth: number): number {
  const words = text.split(/(?<=[\s-])/).filter((w) => w.trim() !== '');
  if (words.length === 0) return 0;
  const em = boxWidth / Math.max(fontSize, 0.01);
  let lines = 1;
  let used = 0;
  for (const word of words) {
    const w = textWidthEm(word.trim());
    if (used > 0 && used + w > em) {
      lines++;
      used = w;
      continue;
    }
    used += w;
  }
  return lines;
}

/**
 * Estimated drawn height of a member card (poster px, at the unit's scale).
 *
 * The DOM sizes the real card, so nothing can ASK it for this height outside a browser - and the
 * two things that need it, the overlap warning and the published document, are computed where there
 * is no layout. It is an estimate and it is used for a WARNING, never to place anything.
 */
export function memberCardHeight(
  person: { name: string; role: string },
  card: MemberCardMetrics
): number {
  const box = (card.w - CARD_PAD_X) * FIT_MARGIN;
  const nameLines = Math.max(1, wrappedLineCount(person.name, card.nameSize, box));
  const roleLines = wrappedLineCount(person.role, card.roleSize, box);
  const role = roleLines === 0 ? 0 : ROLE_GAP + roleLines * card.roleSize * ROLE_LINE_HEIGHT;
  return round2(
    CARD_PAD_TOP +
      card.photo +
      NAME_GAP +
      nameLines * card.nameSize * NAME_LINE_HEIGHT +
      role +
      CARD_PAD_BOTTOM
  );
}

/** The members a unit draws, in their slots - what {@link resolveUnitMembers} returns. */
export interface ShownMembers {
  president: PosterMemberRef | null;
  bureau: PosterMemberRef[];
}

/** One member card placed in unit-local coordinates (poster px at the unit's own scale 1). */
export interface PlacedCard {
  member: PosterMemberRef;
  slot: MemberSlot;
  card: MemberCardMetrics;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Places every card a unit draws, at one shared name size.
 *
 * The single source of where a card sits: the renderer, the publisher, the overlap warning and the
 * size search below all read it, so none of them can place a card the others do not know about.
 */
export function placeUnitCards(shown: ShownMembers, nameSize?: number): PlacedCard[] {
  const placed: PlacedCard[] = [];
  shown.bureau.forEach((member, i) => {
    const card = memberCardMetrics(member.name, 'bureau', nameSize);
    const offset = bureauCrownOffset(i);
    placed.push({
      member,
      slot: 'bureau',
      card,
      x: UNIT_CX + offset.x - card.w / 2,
      y: BUREAU_CROWN_CY + offset.y - card.base / 2,
      w: card.w,
      h: memberCardHeight(member, card),
    });
  });
  if (shown.president) {
    const card = memberCardMetrics(shown.president.name, 'president', nameSize);
    placed.push({
      member: shown.president,
      slot: 'president',
      card,
      x: UNIT_CX - card.w / 2,
      y: PRES_TOP,
      w: card.w,
      h: memberCardHeight(shown.president, card),
    });
  }
  return placed;
}

/** Whether any two of a unit's cards are drawn over each other. */
function cardsCollide(shown: ShownMembers, nameSize: number): boolean {
  const placed = placeUnitCards(shown, nameSize);
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      if (
        Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0 &&
        Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Smallest name size the search may settle on (unit px), when even that collides. */
const MIN_UNIT_NAME_SIZE = 4;
/** The search grid: finer than this is invisible at any print size. */
const NAME_SIZE_STEP = 0.1;

/**
 * The ONE name size every card in a unit shares, grown as far as the crown allows.
 *
 * Two decisions, taken with the user on 2026-09-27, meet here.
 *
 * **D12 - the crown does not grow.** Taking the card text fully out of the unit's scale would make
 * the cards collide INSIDE the unit long before they became readable: at the scale the seed grid
 * uses (0.46) the crown's levels are ~94 px apart for a card already ~82 px tall. Growing the crown
 * radii with the text was refused - a unit keeps the footprint its author gave it - so the text
 * grows only as far as the cards still clear each other, and the smallest units reach ~7-8 pt on A0
 * rather than the 9.5 pt floor. That shortfall is accepted and is why this returns a size rather
 * than promising one.
 *
 * **D13 - one size per UNIT.** Not one per poster, which would be the size the SMALLEST bubble can
 * take and would drag every card down; and not one per card, which is what printed "Thomas
 * DELLESTABLE" at 4.6 px beside a neighbour at 6.4 px in the same crown.
 *
 * Monotonic by construction - a larger size only ever grows a card - so the answer is found by
 * halving the interval rather than walking it, which matters: this runs for every unit on every
 * pointer frame of a drag.
 *
 * @param shown - The members the unit draws.
 * @param unitScale - The unit's scale; the readable target is expressed on the SHEET and divided by
 *   it, since everything in a unit is drawn through that scale.
 * @returns The shared name size, in unit px.
 */
export function fitUnitNameSize(shown: ShownMembers, unitScale: number): number {
  const target = Math.max(PRES_NAME_BASE, MIN_POSTER_TEXT_PX / Math.max(unitScale, 0.01));
  if (!cardsCollide(shown, target)) return round2(target);

  let lo = MIN_UNIT_NAME_SIZE;
  let hi = target;
  while (hi - lo > NAME_SIZE_STEP) {
    const mid = (lo + hi) / 2;
    if (cardsCollide(shown, mid)) hi = mid;
    else lo = mid;
  }
  return round2(lo);
}

/** A box on the stage, in poster px. */
export interface UnitBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The box a unit actually covers on the stage - its INK, not its slot.
 *
 * {@link CARD_WIDTH} x {@link CARD_HEIGHT} is the seed grid's cell and is mostly empty, so two
 * units whose cells cross very often do not touch on the page. What a reader sees crossing is the
 * blob, the crown of member cards around its top and the president's card under it, which is what
 * this measures - the difference is the reason the warning is worth reading at all.
 *
 * The hero logo is ignored: it is centered on the blob and {@link LOGO_BASE} is small enough that
 * no frame shape reaches past the blob's rim.
 */
export function unitInkBox(bubble: PositionedBubble, members: PosterMemberRef[]): UnitBox {
  const shown = resolveUnitMembers(bubble, members);
  const nameSize = fitUnitNameSize(shown, bubble.scale);
  let left = UNIT_CX - BLOB_SIZE / 2;
  let right = UNIT_CX + BLOB_SIZE / 2;
  let top = BLOB_CY - BLOB_SIZE / 2;
  let bottom = BLOB_CY + BLOB_SIZE / 2;
  const cover = (x: number, y: number, w: number, h: number): void => {
    left = Math.min(left, x);
    right = Math.max(right, x + w);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y + h);
  };

  for (const placed of placeUnitCards(shown, nameSize)) {
    cover(placed.x, placed.y, placed.w, placed.h);
  }

  return {
    x: round2(bubble.x + left * bubble.scale),
    y: round2(bubble.y + top * bubble.scale),
    w: round2((right - left) * bubble.scale),
    h: round2((bottom - top) * bubble.scale),
  };
}

/** Two units drawn over each other, and by how much. */
export interface UnitOverlap {
  /** The two associations, in the order the caller gave them. */
  a: string;
  b: string;
  /** Area of the intersection, in poster px squared. */
  area: number;
}

/**
 * Every pair of units whose ink boxes cross, worst first.
 *
 * Decided with the user on 2026-09-27 (D7): an overlap is WARNED and never repaired. Nudging a unit
 * would undo a placement made by hand, and the author is the only one who knows which of the two
 * should move - so this reports, and the editor draws the boxes it names.
 *
 * @param units - Each association's box, as {@link unitInkBox} returns it.
 * @returns One entry per crossing pair, largest intersection first. Touching edges are not a
 *   crossing: a zero area would put the poster's neatest placements at the top of a warning list.
 */
export function findUnitOverlaps(units: { assoId: string; box: UnitBox }[]): UnitOverlap[] {
  const found: UnitOverlap[] = [];
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i].box;
      const b = units[j].box;
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (w <= 0 || h <= 0) continue;
      found.push({ a: units[i].assoId, b: units[j].assoId, area: round2(w * h) });
    }
  }
  return found.sort((x, y) => y.area - x.area);
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
