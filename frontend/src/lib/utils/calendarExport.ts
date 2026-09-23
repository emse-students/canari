import { contrastColor } from './color';
import { associationAccentHex } from '$lib/associations/accent';
import { exportSearchablePdf } from '$lib/pdf/searchableRaster';
import { getLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import type { AssociationCalendarFeedEvent } from '$lib/associations/api';
import {
  breaksOnDay,
  dayOccupancy,
  eventCardsOnDay,
  type DayOccupancy,
} from '$lib/calendar/feedEvents';
import { localizedWeekdays, monthGridDays } from '$lib/calendar/monthGrid';

/**
 * Height of the A4 landscape calendar container in pixels (1080px logical width).
 * Pinned to the EXACT A4 landscape ratio (297:210) so the rasterised canvas fills a standard A4
 * page with no distortion and no white bar - the container itself is the page.
 */
export const CALENDAR_CONTAINER_HEIGHT = Math.round((210 * 1080) / 297); // = 764

/**
 * THE SHEET'S GEOMETRY, MEASURED OFF THE BDE'S OWN CANVA PLANNING AND SCALED TO 1080.
 *
 * Every number below is read from `Planning d'octobre` (a 1168x827 Canva page, itself A4 landscape)
 * and multiplied by 1080/1168. They are not taste: the sheet this export replaces was drawn by hand
 * every month, and the point of the 2026-09-23 rework is that nobody has to draw it again.
 *
 * What the old numbers were, and why none of them survived: the sheet had an 88px HEADER BAR and a
 * 40px WEEKDAY BAR, both filled with a solid colour, over a grid whose cells touched each other and
 * were separated by 1px rules inside a 1.5px frame. The Canva has none of that - the title and the
 * weekday names sit directly on the photograph, and the days are detached cards with air between
 * them. A bar and a rule cannot be "configured" into not existing, so they are gone, and the nine
 * colour controls that pointed at them went with them.
 */
const SHEET_PAD_X = 20;
/** Top of the first row of day cells - everything above it is the title and the weekday names. */
const GRID_TOP = 181;
/** Free space kept under the last row, so the sheet does not end flush against the paper edge. */
const GRID_BOTTOM = 34;
const COL_GAP = 23;
const ROW_GAP = 16;
const TITLE_PAD_TOP = 8;
const TITLE_SIZE = 98;
const WEEKDAY_ROW_H = 44;
const WEEKDAY_SIZE = 31;
/**
 * Height of the row carrying the day number on the FIRST slot of a day, and the size of the number.
 *
 * Exported because `MonthCalendarGridRich` takes the same decision for the same reason: the day
 * number gets a row of its own that the title cannot enter, so a long title cannot run over it.
 * A corner-pinned number is invisible to a centred title, and the two only avoid each other by
 * luck - which held at 182px cells and stopped holding at 128px, where "29" read as "2".
 *
 * THE CANVA PUTS ITS NUMBER BOTTOM-RIGHT, ON TOP OF THE CARD, AND WE DO NOT (user, 2026-09-23:
 * *"tout doit etre lisible et rien ne doit se chevaucher"*). Only the size follows the Canva, and
 * only as far as a reserved row allows.
 */
export const DAY_NUM_H = 22;
const DAY_NUM_SIZE = 15;

/**
 * The break stamp: a word written across the day at an angle, the Canva's rendering of "Vacances".
 *
 * The angle is steep enough that the word reads as a stamp rather than as a mis-set line, and the
 * size is the Canva's 23.5px scaled to this sheet. Both are constants because a break is the only
 * thing they describe, and one more slider for one more word is exactly what was deleted here.
 */
const BREAK_LABEL_SIZE = 22;
const BREAK_LABEL_ANGLE = -20;

const MAX_SHOW = 3;

/**
 * The block shadow's offset for a given font size - down and to the LEFT, as the Canva draws it.
 *
 * It is derived rather than configured because it is not an independent choice: a hard-offset
 * duplicate reads as a shadow only while the offset stays proportional to the stroke, and a single
 * number set for a 98px title turns into a smudge under a 15px day number. One control fewer, and
 * one way for the sheet to look wrong fewer.
 */
function blockShadowCss(fontSize: number, color: string): string {
  const offset = Math.max(2, Math.round(fontSize * 0.05));
  return `text-shadow:${-offset}px ${offset}px 0 ${color};`;
}

/**
 * What the sheet still lets a human decide - and it is deliberately short.
 *
 * NINE CONTROLS WERE DELETED ON 2026-09-23 BECAUSE THEIR SUBJECT WAS (user: *"ce truc la est quand
 * meme une vraie usine a gaz"*). The header bar, the weekday bar, the inner rules and the outer
 * frame are not part of this design any more, so `headerBg`, `weekdayRowBg`, `borderColor` and
 * `gridOuterBorder` had nothing left to colour. Four more were not choices in the first place: the
 * two weekday label colours are one text colour, `emptyDayColor` is whatever contrasts with the
 * cell, the shadow offset follows the font size, and `weekdayFullNames` is always true because the
 * sheet it copies always spells them out.
 *
 * WHAT IS LEFT IS AN IMAGE AND SIX NUMBERS, and the three colours are pre-filled FROM the image by
 * {@link paletteFromImage}, so the ordinary month is: drop in a photo, export.
 */
export interface CalendarExportOptions {
  /** Base64 data: URL for the full-page background image. */
  bgDataUrl?: string | null;
  /** Background image opacity in percent (0-100). Default: 100 - the photo IS the design. */
  bgOpacity?: number;
  /**
   * Dark scrim opacity in percent (0-100) laid over the background IMAGE for legibility. Default: 0.
   * Only has an effect when `bgDataUrl` is set.
   */
  scrimOpacity?: number;
  /** Month title + weekday name colour (hex). Default: '#ffffff'. */
  textColor?: string;
  /**
   * The one accent: the block shadow behind every display text, and the break label. Default the
   * Canva's deep red.
   */
  accentColor?: string;
  /** Day cell fill colour (hex). Default: a neutral grey. */
  cellBg?: string;
  /** Day cell fill opacity in percent (0-100). Default: 58 - the photo has to read through it. */
  cellBgOpacity?: number;
  /**
   * Association logo watermark opacity in percent (0-100). Default: 55.
   *
   * It was 18-22 and hardcoded, which is what made the sheet look empty next to the Canva: there the
   * logos are the loudest thing in a cell. It is a control rather than a constant because it trades
   * directly against the title drawn over it, and that trade depends on the logos of the month.
   */
  logoOpacity?: number;
}

/** The starting point, and the only one - see {@link CalendarExportOptions}. */
export const DEFAULT_EXPORT_OPTIONS: Required<Omit<CalendarExportOptions, 'bgDataUrl'>> = {
  bgOpacity: 100,
  scrimOpacity: 0,
  textColor: '#ffffff',
  accentColor: '#a01f2d',
  cellBg: '#8b939c',
  cellBgOpacity: 58,
  logoOpacity: 55,
};

/** Colour of the scrim - a legibility device over a photograph, never a design choice. */
const SCRIM_COLOR = '#0b1220';

type ResolvedOpts = Required<CalendarExportOptions>;

function hexToRgba(hex: string, opacityPct: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${(opacityPct / 100).toFixed(2)})`;
}

/**
 * Event card fill opacity in percent. Below full so the color reads softer (less vivid) and the
 * association logo watermark behind it stays visible - the color tints the cell rather than masking it.
 */
const EVENT_BG_OPACITY = 82;

/** Returns all hex colors for an event: primary first, then co-owners. */
function eventHexColors(ev: AssociationCalendarFeedEvent): string[] {
  const primary = associationAccentHex({ id: ev.associationId, color: ev.associationColor });
  return [
    primary,
    ...(ev.coOwners ?? []).map((co) =>
      associationAccentHex({ id: co.associationId, color: co.color })
    ),
  ];
}

/**
 * CSS background value for an event slot - a translucent solid fill, or a translucent inline gradient
 * for co-owned events (one equal band per owner). Reduced alpha keeps the color soft and lets the
 * logo watermark show through.
 */
export function eventBgCss(ev: AssociationCalendarFeedEvent): string {
  const colors = eventHexColors(ev).map((c) => hexToRgba(c, EVENT_BG_OPACITY));
  if (colors.length === 1) return colors[0];
  const pct = 100 / colors.length;
  const stops = colors.flatMap((c, i) => [
    `${c} ${(i * pct).toFixed(1)}%`,
    `${c} ${((i + 1) * pct).toFixed(1)}%`,
  ]);
  return `linear-gradient(to right,${stops.join(',')})`;
}

/** Monday-first array of day-numbers (null = padding cell) for a given month. */

function safe(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Line-height shared by the event-title fit computation and the rendered spans (must match). */
export const EVENT_TITLE_LINE_HEIGHT = 1.25;

/**
 * Picks a font size, line clamp and horizontal padding so an event title fills the available cell
 * height `availH` (px) with as many lines as fit, minimising truncation. The clamp is the physical
 * last-resort cap (a cell has a fixed height); the lower font floor and the matched line-height let
 * far more text show fully than a single ellipsised line would.
 *
 * `minFontSize` IS WHAT SEPARATES THE SHEET FROM THE SCREEN, and it is the only difference between
 * the two callers. The PDF may go down to 9px: it is rasterised at A4 and read on paper. The app
 * may not - `--text-2xs` is 12px and `app.css` states in as many words that nothing goes below it,
 * that step being "the single largest contributor to 'pas assez ergonomique'". So the screen passes
 * 12 and buys its fit in LINES instead: a slot too short for two lines of 12px shows one, where the
 * sheet would have shrunk the type. At that floor the ladder can only land on 12 or 13, which are
 * exactly `--text-2xs` and `--text-xs` - the screen never leaves the scale.
 */
export function fitEventText(
  availH: number,
  minFontSize = 9
): { fontSize: number; clampCss: string; ph: number } {
  const ladder = availH >= 56 ? 13 : availH >= 42 ? 12 : availH >= 30 ? 11 : availH >= 22 ? 10 : 9;
  const fontSize = Math.max(ladder, minFontSize);
  const maxLines = Math.max(1, Math.floor(availH / (fontSize * EVENT_TITLE_LINE_HEIGHT)));
  const ph = availH >= 40 ? 8 : 5;
  const clampCss = `display:-webkit-box;-webkit-line-clamp:${maxLines};-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;`;
  return { fontSize, clampCss, ph };
}

/** Reads a File and resolves to its base64 data: URL (no CORS, fully client-side). */
export async function fileToDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

/** Fetches a URL and returns a base64 data: string, or null on any failure. */
async function fetchDataUrl(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const resp = await fetch(url);
    // A logo that fails to inline is simply absent from the PDF, with nothing on screen saying so -
    // the export "succeeds" and one association silently loses its watermark. Log every failure:
    // it is the only way to tell a logo that could not be fetched from one that was never set.
    if (!resp.ok) {
      console.warn(`[CalendarExport] Logo fetch failed (HTTP ${resp.status}): ${url}`);
      return null;
    }
    const blob = await resp.blob();
    return new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => {
        console.warn(`[CalendarExport] Logo could not be read as a data URL: ${url}`);
        resolve(null);
      };
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.warn(`[CalendarExport] Logo fetch threw for ${url}: ${String(e)}`);
    return null;
  }
}

/** Geometry of one band of a split logo watermark, as percentages. */
export interface LogoBand {
  /** Band window offset from the circle's left edge, in % of the circle width. */
  leftPct: number;
  /** Band window width, in % of the circle width. */
  widthPct: number;
  /** Offset of the full-size logo inside its band, in % of the BAND width (0 for the first). */
  imgLeftPct: number;
  /** Width the full-size logo must have inside its band, in % of the BAND width. */
  imgWidthPct: number;
}

/** Where one day's visible events sit in its cell. */
export interface DaySlotLayout {
  /** How many equal slots the cell is divided into. */
  nSlots: number;
  /** The slot each visible event occupies, index-aligned with the events passed in. */
  slotOf: number[];
  /** The slot the "+N autres" row occupies, or null when there is no overflow. */
  overflowSlot: number | null;
}

/**
 * How to divide a day cell, shared by the screen grid and the PDF export.
 *
 * ORDINARILY this is one slot per entry, stacked in order - that is what a full day looks like and
 * it has not changed. The ONE special case is a day with exactly one event, no overflow, AND an
 * event that leaves half the day free: the cell splits in two and the event takes its half,
 * leaving the other as background.
 *
 * IT TAKES OCCUPANCIES RATHER THAN START HOURS, and that is the whole of the 2026-09-16 fix: both
 * callers used to hand it `startsAt.getHours()` on every square a multi-day event covered, so a
 * WEI's Friday-evening hour decided the shape of Saturday and Sunday as well. `dayOccupancy` is
 * asked per square instead, and a day the event holds end to end answers `full` - one slot.
 *
 * It lives here, beside `fitEventText` and `splitLogoBands`, because those two are already the
 * reason the screen and the sheet agree. A layout rule written in the component would be a rule
 * the export does not have, and the grid exists to be printable.
 */
export function daySlotLayout(occupancies: DayOccupancy[], overflowCount: number): DaySlotLayout {
  if (occupancies.length === 1 && overflowCount === 0 && occupancies[0] !== 'full') {
    return {
      nSlots: 2,
      slotOf: [occupancies[0] === 'morning' ? 0 : 1],
      overflowSlot: null,
    };
  }
  const hasOverflow = overflowCount > 0;
  return {
    nSlots: occupancies.length + (hasOverflow ? 1 : 0),
    slotOf: occupancies.map((_, i) => i),
    overflowSlot: hasOverflow ? occupancies.length : null,
  };
}

/**
 * Band geometry for an `n`-owner split watermark, in percentages so it is unit-free.
 *
 * This is the single definition of the split, shared by the two surfaces that draw it: the PDF
 * export ({@link splitLogoWatermark}, which scales these to px) and the on-screen calendar grid
 * (`MonthCalendarGridRich.svelte`, which uses them as-is). They MUST agree - the export was fixed
 * on 2026-08-01 while the grid was left showing a row of small separate logos, so the surface the
 * user actually looks at still contradicted the decided design.
 */
export function splitLogoBands(n: number): LogoBand[] {
  return Array.from({ length: n }, (_, i) => ({
    leftPct: (i * 100) / n,
    widthPct: 100 / n,
    // The logo keeps the circle's full width inside a band that is 1/n of it, shifted left by i
    // whole band widths so each band exposes only its own vertical slice.
    imgLeftPct: -i * 100,
    imgWidthPct: n * 100,
  }));
}

/**
 * Watermark for a co-owned event: the owners' logos are merged into ONE circle split into equal
 * vertical bands, each band cut from a different logo (2 owners -> left half of logo 1 on the left,
 * right half of logo 2 on the right). Each band is a window onto a full-size logo shifted so only its
 * own vertical slice shows, so the bands line up into a single seamless circle rather than a row of
 * small separate logos.
 *
 * A band is reserved per OWNER, so `logoSrcs` must stay positional: a `null` leaves that owner's
 * half empty. Dropping the nulls instead would renumber the bands - two owners with one resolvable
 * logo would collapse to n=1 and draw that logo WHOLE across the circle, which is indistinguishable
 * from a working two-logo split and hides the fact that a logo failed to load.
 *
 * `opacity` is the caller's, not a constant: the watermark is the loudest thing in a Canva cell and
 * the faintest thing in the sheet that copied it, and which of the two is right depends on the
 * logos of the month - see {@link CalendarExportOptions.logoOpacity}.
 *
 * Each band image MUST carry `max-width:none;max-height:none`. This markup is rendered inside the
 * app document (the preview inline, the export in an offscreen container), so Tailwind's Preflight
 * `img { max-width: 100% }` applies to it and clamps the logo to its BAND rather than the circle -
 * the image then measures one half-width, and the band at `left:-bandW` is pushed entirely outside
 * its own window and paints nothing. That is a right half that vanishes while the left one survives
 * as a squeezed centre strip, which reads exactly like "the second logo is missing". It reproduces
 * only inside the app: a standalone probe page has no Preflight and renders the split correctly.
 */
export function splitLogoWatermark(
  logoSrcs: (string | null)[],
  size: number,
  opacity = 0.2
): string {
  const geometry = splitLogoBands(logoSrcs.length);
  const bands = logoSrcs
    .map((src, i) => {
      if (src === null) return '';
      const b = geometry[i];
      const left = (b.leftPct / 100) * size;
      const width = (b.widthPct / 100) * size;
      const imgLeft = (b.imgLeftPct / 100) * width;
      return `<div style="position:absolute;top:0;left:${left.toFixed(2)}px;width:${width.toFixed(2)}px;height:${size}px;overflow:hidden;"><img src="${src}" style="position:absolute;top:0;left:${imgLeft.toFixed(2)}px;width:${size}px;height:${size}px;max-width:none;max-height:none;object-fit:cover;" /></div>`;
    })
    .join('');
  return `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;"><div style="position:relative;width:${size}px;height:${size}px;border-radius:50%;overflow:hidden;opacity:${opacity.toFixed(2)};">${bands}</div></div>`;
}

/**
 * Mixes `hex` toward black by `ratio`, for the shades the sheet derives rather than asks for.
 *
 * A NEGATIVE RATIO LIGHTENS, toward white rather than past it: scaling a channel up overflows on
 * anything already bright, and a pale grey would come back pure white with its hue thrown away.
 */
function darken(hex: string, ratio: number): string {
  const h = hex.replace('#', '');
  const channel = (i: number) => {
    const value = parseInt(h.slice(i, i + 2), 16);
    const mixed = ratio >= 0 ? value * (1 - ratio) : value + (255 - value) * -ratio;
    return Math.round(mixed).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(2)}${channel(4)}`;
}

/**
 * Builds the inner calendar HTML (no `<!DOCTYPE>` wrapper).
 *
 * `logoMap`: pass a `Map` of data-URL overrides for the PDF export, or `'direct'` to use
 * `ev.associationLogoUrl` directly (suitable for the in-document preview, same origin).
 *
 * THE TWO DISPLAY FACES ARE ASKED FOR AT WEIGHT 400 AND THAT IS NOT A DETAIL. Leckerli One and
 * Chewy ship one weight; a `font-weight:700` here would be synthesised by the browser for the
 * raster while `pickAppFont` draws the only real outline over it, and the PDF's vector text would
 * sit thinner than the picture under it. Their CSS is loaded by the export route, the one page that
 * renders this markup - `MonthCalendarGridRich` imports this module too and must not pay for fonts
 * it never draws.
 */
function buildCalendarHtml(
  events: AssociationCalendarFeedEvent[],
  year: number,
  month: number,
  opts: ResolvedOpts,
  logoMap: Map<string, string | null> | 'direct'
): string {
  const locale = getLocale();
  const monthLabel = new Intl.DateTimeFormat(locale, { month: 'long' })
    .format(new Date(year, month, 1))
    .replace(/^\w/, (c) => c.toUpperCase());

  const cells = monthGridDays(new Date(year, month, 1));
  const nRows = cells.length / 7;
  // The rows share whatever is left between the weekday names and the bottom margin, gaps included,
  // so a 4-row month gets taller cells rather than a band of empty paper under the last one.
  const CELL_H = Math.floor(
    (CALENDAR_CONTAINER_HEIGHT - GRID_TOP - GRID_BOTTOM - (nRows - 1) * ROW_GAP) / nRows
  );

  // Weekday names are always spelt in full: the sheet this copies does, and the switch for it was
  // one of the nine controls deleted along with the design they configured.
  const weekdayNames = localizedWeekdays(locale, 'long');
  const gridPad = `padding:0 ${SHEET_PAD_X}px;`;
  const headerRow = weekdayNames
    .map(
      (w) =>
        // The marker sits on the inner span, never on the padded box: the vector re-draw anchors a
        // run to the TOP of the marked element and knows nothing about padding, so marking the box
        // drew the label 11px above where the preview shows it. Flex centring also makes the row
        // height explicit rather than padding-derived.
        `<div style="height:${WEEKDAY_ROW_H}px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;"><span data-pdf-text style="font-family:'Chewy','Fredoka Variable',sans-serif;font-size:${WEEKDAY_SIZE}px;font-weight:400;line-height:1.1;color:${opts.textColor};${blockShadowCss(WEEKDAY_SIZE, opts.accentColor)}">${safe(w)}</span></div>`
    )
    .join('');

  const cellBgNormal = hexToRgba(opts.cellBg, opts.cellBgOpacity);
  // The Canva makes no distinction, but the user asked to keep one, and a shade of the same colour
  // keeps it a distinction rather than a second palette entry (2026-09-23: *"on peut garder une
  // distinction de fond quand meme, c'est plus lisible"*).
  const cellBgWeekend = hexToRgba(darken(opts.cellBg, 0.16), opts.cellBgOpacity);
  // A day outside the month is an empty card and nothing else - no number, no events. The Canva
  // fills those squares by hand with September's evenings; the feed this sheet reads is one month
  // wide, so it could not, and the user chose the empty card over widening the fetch.
  const cellBgPadding = hexToRgba(opts.cellBg, Math.max(0, opts.cellBgOpacity - 18));
  const emptyDayColor = contrastColor(opts.cellBg);
  const logoAlpha = opts.logoOpacity / 100;

  const cellHtml = cells
    .map((day, i) => {
      const isWeekend = i % 7 >= 5;
      const cellBase = `height:${CELL_H}px;overflow:hidden;box-sizing:border-box;`;

      if (day === null) {
        return `<div style="${cellBase}background:${cellBgPadding};"></div>`;
      }

      // The square this cell paints, and the ONE definition of which events land on it - the 05:00
      // day boundary included, which a private copy here used to cut at midnight.
      const square = new Date(year, month, day);
      const dayEvents = eventCardsOnDay(events, square, day);
      const dayBreaks = breaksOnDay(events, square, day);
      const bg = isWeekend ? cellBgWeekend : cellBgNormal;

      /*
       * A BREAK IS A WORD WRITTEN ACROSS THE DAY, not a tint under it (user, 2026-09-23). The faint
       * full-cell wash and the 3px strip are gone: on a photographic background a 14% tint is
       * invisible, which is why the Canva never used one and stamped "Vacances" on each day instead.
       *
       * It is stamped only on a day with nothing else on it, and that is the honest reading of the
       * rule rather than an exception to it: a rotated word across two event cards makes three
       * things unreadable. A busy break day keeps the strip, which says the same thing quietly.
       * October has no such day, so nothing here is claimed to have been seen.
       */
      const hasBreak = dayBreaks.length > 0;
      const breakStamp =
        hasBreak && dayEvents.length === 0
          ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;"><span data-pdf-text style="font-size:${BREAK_LABEL_SIZE}px;font-weight:800;color:${opts.textColor};line-height:1.1;white-space:nowrap;transform:rotate(${BREAK_LABEL_ANGLE}deg);${blockShadowCss(BREAK_LABEL_SIZE, opts.accentColor)}">${safe(dayBreaks[0].title)}</span></div>`
          : '';
      const breakStrip =
        hasBreak && dayEvents.length > 0
          ? `<div style="position:absolute;bottom:0;left:0;right:0;height:3px;background:${opts.accentColor};"></div>`
          : '';

      if (dayEvents.length === 0) {
        return `<div style="position:relative;${cellBase}background:${bg};padding:6px 8px;"><span data-pdf-text style="position:relative;font-size:${DAY_NUM_SIZE}px;font-weight:800;color:${emptyDayColor};line-height:1;">${day}</span>${breakStamp}</div>`;
      }

      const nVisible = dayEvents.length > MAX_SHOW ? MAX_SHOW - 1 : dayEvents.length;
      const visible = dayEvents.slice(0, nVisible);
      const overflowCount = dayEvents.length - nVisible;
      // The same rule the screen grid asks, so the sheet and the screen cannot divide a cell
      // differently: ordinarily one slot per entry, and a lone event that leaves half THIS day free
      // takes that half.
      const layout = daySlotLayout(
        visible.map((ev) => dayOccupancy(ev, square)),
        overflowCount
      );
      const slotH = Math.floor(CELL_H / layout.nSlots);
      const loneSlot =
        visible.length === 1 && overflowCount === 0 && layout.nSlots === 2
          ? layout.slotOf[0]
          : null;
      // An empty half, carrying the day number when it is the FIRST slot - the number belongs to
      // slot 0, and slot 0 no longer always holds an event.
      const blankHalf = (withDayNumber: boolean) =>
        `<div style="height:${slotH}px;position:relative;box-sizing:border-box;">${
          withDayNumber
            ? `<div style="padding:6px 0 0 8px;"><span data-pdf-text style="font-size:${DAY_NUM_SIZE}px;font-weight:800;color:${emptyDayColor};line-height:1;">${day}</span></div>`
            : ''
        }</div>`;

      const rows = [
        ...(loneSlot === 1 ? [blankHalf(true)] : []),
        ...visible.map((ev, idx) => {
          const evBg = eventBgCss(ev);
          const fg = contrastColor(eventHexColors(ev)[0]);

          // Resolve logos (primary + co-owners): data URL map for the export, direct URL for preview.
          const resolveLogo = (url: string | null | undefined): string | null =>
            url ? (logoMap === 'direct' ? url : (logoMap.get(url) ?? null)) : null;
          // Positional, one entry per OWNER, nulls kept: the split reserves a band per owner, so
          // dropping the unresolved ones renumbers the bands. Two owners with one usable logo then
          // collapsed to the single-logo branch and drew it WHOLE across the circle - which looks
          // exactly like a working split and is why "the second logo is missing" stayed unexplained
          // for so long: the symptom was disguised as a correct render.
          const owners = [
            { name: ev.associationName, url: ev.associationLogoUrl },
            ...(ev.coOwners ?? []).map((co) => ({ name: co.name, url: co.logoUrl })),
          ];
          const logoSrcs = owners.map((o) => resolveLogo(o.url));
          for (const [oi, o] of owners.entries()) {
            if (logoSrcs[oi] === null) {
              console.warn(
                `[CalendarExport] No logo for "${o.name}" on "${ev.title}" - its half stays empty (logoUrl: ${o.url ?? 'none set'})`
              );
            }
          }

          const logoSize = Math.max(Math.round(slotH * 0.78), 16);
          // Watermark stays absolute - decorative only, doesn't affect flow.
          const watermark = logoSrcs.every((src) => src === null)
            ? ''
            : owners.length === 1
              ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;"><img src="${logoSrcs[0]}" style="height:${logoSize}px;width:${logoSize}px;border-radius:50%;object-fit:cover;opacity:${logoAlpha.toFixed(2)};" /></div>`
              : splitLogoWatermark(logoSrcs, logoSize, logoAlpha);

          const sep = idx > 0 ? 'border-top:1px solid rgba(0,0,0,0.10);' : '';
          // An event title is read over a logo now, not over a flat colour, so it carries the same
          // hard outline the Canva gives it - in black rather than the accent, which belongs to the
          // display faces and would fight the association's own colour.
          const titleShadow = 'text-shadow:-1px 1px 0 rgba(0,0,0,0.55);';

          if (idx === 0 && loneSlot !== 1) {
            // First slot: day number on top, title below - flex column so the rasteriser sees
            // explicit heights and doesn't collapse the text area.
            const availH = slotH - DAY_NUM_H;
            const fit = fitEventText(availH);
            return `<div style="height:${slotH}px;position:relative;background:${evBg};overflow:hidden;${sep}display:flex;flex-direction:column;box-sizing:border-box;">
              ${watermark}
              <div style="height:${DAY_NUM_H}px;flex-shrink:0;padding:6px 0 0 8px;position:relative;"><span data-pdf-text style="font-size:${DAY_NUM_SIZE}px;font-weight:800;color:${fg};line-height:1;">${day}</span></div>
              <div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:0 ${fit.ph}px 2px;box-sizing:border-box;position:relative;"><span style="font-size:${fit.fontSize}px;font-weight:800;color:${fg};line-height:${EVENT_TITLE_LINE_HEIGHT};text-align:center;${titleShadow}${fit.clampCss}">${safe(ev.title)}</span></div>
            </div>`;
          }
          // Subsequent slots: no day number, title fully centred.
          const fit = fitEventText(slotH);
          return `<div style="height:${slotH}px;position:relative;background:${evBg};overflow:hidden;${sep}display:flex;align-items:center;justify-content:center;padding:0 ${fit.ph}px;box-sizing:border-box;">
              ${watermark}
              <span style="font-size:${fit.fontSize}px;font-weight:800;color:${fg};line-height:${EVENT_TITLE_LINE_HEIGHT};text-align:center;position:relative;${titleShadow}${fit.clampCss}">${safe(ev.title)}</span>
            </div>`;
        }),
        ...(loneSlot === 0 ? [blankHalf(false)] : []),
        ...(overflowCount > 0
          ? [
              `<div style="height:${slotH}px;background:${hexToRgba(darken(opts.cellBg, 0.16), Math.min(100, opts.cellBgOpacity + 20))};display:flex;align-items:center;justify-content:center;overflow:hidden;"><span data-pdf-text style="font-size:10px;font-weight:800;color:${emptyDayColor};">${safe(m.calendar_export_more_events({ count: overflowCount }))}</span></div>`,
            ]
          : []),
      ];

      return `<div style="position:relative;${cellBase}background:${bg};">${rows.join('')}${breakStamp}${breakStrip}</div>`;
    })
    .join('');

  // Optional dark scrim over the image so text stays legible on a busy full-bleed photo. Nested in
  // the same [data-full-bg] layer so the export's single height patch covers it too.
  const scrimLayer =
    opts.scrimOpacity > 0
      ? `<div style="position:absolute;inset:0;background:${SCRIM_COLOR};opacity:${(opts.scrimOpacity / 100).toFixed(2)};"></div>`
      : '';
  // Full-page background image behind everything, CROPPED to the sheet.
  //
  // A CSS background on a box pinned to the container (inset:0) crops against a box that always has
  // the sheet's exact dimensions, in both the preview and the export, with nothing to patch after
  // insertion - which an <img> with object-fit in a height-less div did not, leaving bands wherever
  // the photo's aspect did not match A4. It also survives rasterisation more predictably, the
  // DOM-to-SVG serialiser having to reproduce object-fit on an inline replaced element.
  //
  // The image layer carries the opacity and the scrim is its SIBLING, not its child: the scrim is a
  // legibility device over the photo and must not be faded along with it.
  const fullBgHtml = opts.bgDataUrl
    ? `<div data-full-bg style="position:absolute;inset:0;overflow:hidden;pointer-events:none;"><div style="position:absolute;inset:0;background-image:url('${opts.bgDataUrl}');background-size:cover;background-position:center;background-repeat:no-repeat;opacity:${(opts.bgOpacity / 100).toFixed(2)};"></div>${scrimLayer}</div>`
    : '';

  return `
    ${fullBgHtml}
    <div style="position:relative;">
      <div style="padding:${TITLE_PAD_TOP}px ${SHEET_PAD_X}px 0;display:flex;align-items:center;justify-content:center;">
        <span data-pdf-text style="font-family:'Leckerli One','Fredoka Variable',cursive;font-size:${TITLE_SIZE}px;font-weight:400;line-height:1.15;color:${opts.textColor};${blockShadowCss(TITLE_SIZE, opts.accentColor)}">${safe(monthLabel)}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);column-gap:${COL_GAP}px;${gridPad}">
        ${headerRow}
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);column-gap:${COL_GAP}px;row-gap:${ROW_GAP}px;${gridPad}">
        ${cellHtml}
      </div>
    </div>`;
}

/**
 * What the sheet is painted on under everything else.
 *
 * `pageBg` used to be a colour picker, and on a sheet whose background is a full-bleed photograph it
 * was a control for something nobody sees. It only shows through when no image is set, so it is the
 * cell colour lightened - which keeps an image-less sheet coherent instead of grey cards on a blue
 * page nobody chose.
 */
function sheetBaseColor(opts: ResolvedOpts): string {
  return darken(opts.cellBg, -0.55);
}

/** The 1080px logical width of the rendered calendar, shared by the preview and the export. */
export const CALENDAR_CONTAINER_WIDTH = 1080;

/**
 * Builds the live-preview inner HTML, rendered *in the app document* (not an iframe) so it inherits
 * the application's actual fonts ('Fredoka Variable' / 'Nunito Variable'). This is the key to a
 * preview that matches the export pixel-for-pixel: the export rasterises the same markup with the
 * same fonts and the same wrapper (width, background, font-family) via snapdom (which serialises the
 * DOM into an SVG foreignObject and lets the browser paint it). Logos use direct same-origin URLs in
 * the preview; the export pre-fetches them as data: URLs so snapdom reliably embeds them in the SVG.
 */
export function buildPreviewInnerHtml(
  events: AssociationCalendarFeedEvent[],
  year: number,
  month: number,
  options: CalendarExportOptions = {}
): string {
  const opts: ResolvedOpts = { ...DEFAULT_EXPORT_OPTIONS, bgDataUrl: null, ...options };
  const body = buildCalendarHtml(events, year, month, opts, 'direct');
  // Wrapper mirrors the export container exactly (width, background, font-family) so the two render
  // identically. box-sizing/margin/padding resets are inlined since there is no iframe stylesheet.
  // Square corners, like the export: the preview's job is to show the sheet that will print, so a
  // decorative radius belongs to the page chrome around it, never to the sheet itself.
  return `<div style="position:relative;width:${CALENDAR_CONTAINER_WIDTH}px;height:${CALENDAR_CONTAINER_HEIGHT}px;background:${sheetBaseColor(opts)};font-family:'Nunito Variable','Nunito','Segoe UI','Noto Color Emoji Canari',sans-serif;overflow:hidden;box-sizing:border-box;">${body}</div>`;
}

/**
 * Renders the monthly calendar grid to a landscape A4 PDF and triggers a direct download.
 *
 * - Optional background image at configurable opacity.
 * - All colours are fully configurable via `options`; defaults match the original design.
 * - Association logos appear as circular watermarks (pre-fetched as data: URLs so snapdom embeds them).
 */
export async function exportCalendarMonth(
  events: AssociationCalendarFeedEvent[],
  focusDate: Date,
  options: CalendarExportOptions = {}
): Promise<void> {
  const opts: ResolvedOpts = { ...DEFAULT_EXPORT_OPTIONS, bgDataUrl: null, ...options };

  const year = focusDate.getFullYear();
  const month = focusDate.getMonth();

  // Primary AND co-owner logos, pre-fetched as data URLs so the PDF shows every logo.
  const uniqueLogoUrls = [
    ...new Set(
      events.flatMap((ev) => [
        ev.associationLogoUrl,
        ...(ev.coOwners ?? []).map((co) => co.logoUrl),
      ])
    ),
  ].filter((u): u is string => !!u);
  const resolvedLogos = await Promise.all(uniqueLogoUrls.map(fetchDataUrl));
  const logoMap = new Map<string, string | null>(
    uniqueLogoUrls.map((url, i) => [url, resolvedLogos[i]])
  );

  const innerHtml = buildCalendarHtml(events, year, month, opts, logoMap);

  const container = document.createElement('div');
  Object.assign(container.style, {
    position: 'absolute',
    top: '0',
    left: '-9999px',
    width: '1080px',
    height: `${CALENDAR_CONTAINER_HEIGHT}px`,
    background: sheetBaseColor(opts),
    fontFamily: '"Nunito Variable", "Nunito", "Segoe UI", "Noto Color Emoji Canari", sans-serif',
    boxSizing: 'border-box',
    // No radius: this box IS the sheet, and a sheet of paper has square corners. A radius here
    // rasterises as four transparent notches at the page edge of the PDF.
    overflow: 'hidden',
  });

  container.innerHTML = innerHtml;
  document.body.appendChild(container);

  try {
    await exportSearchablePdf(container, {
      filename: `canari-agenda-${year}-${String(month + 1).padStart(2, '0')}`,
      format: 'a4',
      orientation: 'landscape',
      naturalWidth: 1080,
      naturalHeight: CALENDAR_CONTAINER_HEIGHT,
      rasterScale: 2,
      backgroundColor: sheetBaseColor(opts),
      // Every face the sheet actually draws with. A face missing here is rasterised in whatever the
      // browser had ready, and the vector re-draw then lands on top of a different shape.
      fonts: [
        `400 ${TITLE_SIZE}px 'Leckerli One'`,
        `400 ${WEEKDAY_SIZE}px 'Chewy'`,
        "700 13px 'Nunito Variable'",
        "800 13px 'Nunito Variable'",
      ],
    });
  } finally {
    document.body.removeChild(container);
  }
}
