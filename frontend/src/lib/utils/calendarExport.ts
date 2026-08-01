import { contrastColor, toHex } from './color';
import { generateAvatarColor } from './avatar';
import { exportSearchablePdf } from '$lib/pdf/searchableRaster';
import { getLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import type { AssociationCalendarFeedEvent } from '$lib/associations/api';

/**
 * Localized Monday-first weekday names for the active UI locale via Intl (no hardcoded strings).
 * `style` picks abbreviated ('short', e.g. "Lun"/"Mon") or full ('long', e.g. "Lundi"/"Monday");
 * the first letter is upper-cased and any trailing abbreviation dot is dropped for a clean header.
 */
function localizedWeekdays(locale: string, style: 'short' | 'long'): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: style });
  // 2024-01-01 is a Monday; walk the 7 following days for a Monday-first week.
  return Array.from({ length: 7 }, (_, i) => {
    const name = fmt.format(new Date(2024, 0, 1 + i)).replace(/\.$/, '');
    return name.charAt(0).toUpperCase() + name.slice(1);
  });
}

// Header height. Kept generous so the month title (Fredoka, tall round ascenders) sits low enough in
// its line box to clear the top page edge - a tighter header clipped the glyph tops on export.
const HEADER_H = 88;
const WEEKDAY_ROW_H = 40;
const GRID_PAD_BOTTOM = 20;
/**
 * Height of the A4 landscape calendar container in pixels (1080px logical width).
 * Pinned to the EXACT A4 landscape ratio (297:210) so the rasterised canvas fills a standard A4
 * page with no distortion and no white bar - the container itself is the page.
 */
export const CALENDAR_CONTAINER_HEIGHT = Math.round((210 * 1080) / 297); // = 764
const MAX_SHOW = 3;

/** Configurable visual options for the monthly calendar PDF export. */
export interface CalendarExportOptions {
  /** Base64 data: URL for the full-page background image. */
  bgDataUrl?: string | null;
  /** Background image opacity in percent (0-100). Default: 14. */
  bgOpacity?: number;
  /** Header bar background color (hex). Default: '#151B2C'. */
  headerBg?: string;
  /** Month title text color (hex). Default: '#151B2C'. */
  monthTitleColor?: string;
  /** Weekday row background color (hex). Default: '#151B2C'. */
  weekdayRowBg?: string;
  /** Mon-Fri label color (hex). Default: '#c8d8eb'. */
  weekdayLabelColor?: string;
  /** Sat-Sun label color (hex). Default: '#f5c518'. */
  weekendLabelColor?: string;
  /** Normal day cell background color (hex). Default: '#ffffff'. */
  cellBg?: string;
  /** Normal day cell background opacity in percent (0-100). Default: 92. */
  cellBgOpacity?: number;
  /** Weekend cell background color (hex). Default: '#f1f5f9'. */
  weekendCellBg?: string;
  /** Weekend cell background opacity in percent (0-100). Default: 92. */
  weekendCellBgOpacity?: number;
  /** Cell border color (hex). Default: '#dde3ec'. */
  borderColor?: string;
  /** Grid outer border color (hex). Default: '#151B2C'. */
  gridOuterBorder?: string;
  /** Day number color on event-free cells (hex). Default: '#b8c4d0'. */
  emptyDayColor?: string;
  /**
   * Add a Canva-style block shadow (a hard-offset duplicate of the text, no blur) behind the month
   * title and weekday labels. The duplicate's color and offset are configurable below. Default: false.
   */
  enableTextShadow?: boolean;
  /** Block-shadow color (hex) - the color of the offset text duplicate. Default: '#f5c518'. */
  textShadowColor?: string;
  /** Block-shadow offset in pixels (applied on both x and y for a diagonal translation). Default: 2. */
  textShadowOffset?: number;
  /**
   * Dark scrim opacity in percent (0-100) laid over the background IMAGE for text legibility (the
   * Justine-style "full-bleed photo + readable text" look). Default: 0 (no scrim). Only has an
   * effect when `bgDataUrl` is set.
   */
  scrimOpacity?: number;
  /** Scrim overlay color (hex). Default: '#0b1220'. */
  scrimColor?: string;
  /** Full French weekday names (Lundi...Dimanche) instead of abbreviations (Lun...Dim). Default: false. */
  weekdayFullNames?: boolean;
  /** Break (vacation / no-course) full-cell tint opacity in percent (0-100). Default: 14. */
  breakTintOpacity?: number;
  /** Page (container) background color behind the whole calendar (hex). Default: '#f0f4f8'. */
  pageBg?: string;
}

/** Default values matching the original hardcoded design. */
export const DEFAULT_EXPORT_OPTIONS: Required<Omit<CalendarExportOptions, 'bgDataUrl'>> = {
  bgOpacity: 14,
  // Original design: no extra background on the header bar - it inherits the container bg (#f0f4f8).
  headerBg: '#f0f4f8',
  monthTitleColor: '#151B2C',
  weekdayRowBg: '#151B2C',
  weekdayLabelColor: '#c8d8eb',
  weekendLabelColor: '#f5c518',
  cellBg: '#ffffff',
  cellBgOpacity: 92,
  weekendCellBg: '#f1f5f9',
  weekendCellBgOpacity: 92,
  borderColor: '#dde3ec',
  gridOuterBorder: '#151B2C',
  emptyDayColor: '#b8c4d0',
  enableTextShadow: false,
  textShadowColor: '#f5c518',
  textShadowOffset: 2,
  scrimOpacity: 0,
  scrimColor: '#0b1220',
  weekdayFullNames: false,
  breakTintOpacity: 14,
  pageBg: '#f0f4f8',
};

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
  const primary = toHex(ev.associationColor ?? generateAvatarColor(ev.associationId));
  return [
    primary,
    ...(ev.coOwners ?? []).map((co) => toHex(co.color ?? generateAvatarColor(co.associationId))),
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
function buildCalendarCells(year: number, month: number): (number | null)[] {
  const first = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0).getDate();
  const mondayIndex = (first.getDay() + 6) % 7;
  const cells: (number | null)[] = [];
  for (let i = 0; i < mondayIndex; i++) cells.push(null);
  for (let day = 1; day <= lastDay; day++) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function entriesOnDay(
  events: AssociationCalendarFeedEvent[],
  year: number,
  month: number,
  day: number
): AssociationCalendarFeedEvent[] {
  const d = new Date(year, month, day);
  return events
    .filter((ev) => {
      const start = new Date(ev.startsAt);
      const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      if (!ev.endsAt) return d.getTime() === startDay.getTime();
      const end = new Date(ev.endsAt);
      const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
      return d >= startDay && d <= endDay;
    })
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

/** Normal event cards for a day (breaks excluded - they render as a background band). */
function eventsOnDay(
  events: AssociationCalendarFeedEvent[],
  year: number,
  month: number,
  day: number
): AssociationCalendarFeedEvent[] {
  return entriesOnDay(events, year, month, day).filter((ev) => ev.kind !== 'break');
}

/** Break (no-course / vacation) entries overlapping a day, drawn as a full-day background band. */
function breaksOnDay(
  events: AssociationCalendarFeedEvent[],
  year: number,
  month: number,
  day: number
): AssociationCalendarFeedEvent[] {
  return entriesOnDay(events, year, month, day).filter((ev) => ev.kind === 'break');
}

function safe(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Line-height shared by the event-title fit computation and the rendered spans (must match). */
const EVENT_TITLE_LINE_HEIGHT = 1.25;

/**
 * Picks a font size, line clamp and horizontal padding so an event title fills the available cell
 * height `availH` (px) with as many lines as fit, minimising truncation. The clamp is the physical
 * last-resort cap (a cell has a fixed height); the lower font floor and the matched line-height let
 * far more text show fully than a single ellipsised line would.
 */
function fitEventText(availH: number): { fontSize: number; clampCss: string; ph: number } {
  const fontSize =
    availH >= 56 ? 13 : availH >= 42 ? 12 : availH >= 30 ? 11 : availH >= 22 ? 10 : 9;
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
    console.warn(
      `[CalendarExport] Logo fetch threw for ${url}: ${e instanceof Error ? e.message : String(e)}`
    );
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
 * Each band image MUST carry `max-width:none;max-height:none`. This markup is rendered inside the
 * app document (the preview inline, the export in an offscreen container), so Tailwind's Preflight
 * `img { max-width: 100% }` applies to it and clamps the logo to its BAND rather than the circle -
 * the image then measures one half-width, and the band at `left:-bandW` is pushed entirely outside
 * its own window and paints nothing. That is a right half that vanishes while the left one survives
 * as a squeezed centre strip, which reads exactly like "the second logo is missing". It reproduces
 * only inside the app: a standalone probe page has no Preflight and renders the split correctly.
 */
export function splitLogoWatermark(logoSrcs: (string | null)[], size: number): string {
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
  return `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;"><div style="position:relative;width:${size}px;height:${size}px;border-radius:50%;overflow:hidden;opacity:0.20;">${bands}</div></div>`;
}

/**
 * Builds the inner calendar HTML (no `<!DOCTYPE>` wrapper).
 * - `logoMap`: pass a `Map` of data-URL overrides for the PDF export, or `'direct'` to use
 *   `ev.associationLogoUrl` directly (suitable for the iframe preview, same origin).
 * - `faviconUrl`: data URL for export, or a direct path (e.g. `'/favicon.png'`) for preview.
 */
function buildCalendarHtml(
  events: AssociationCalendarFeedEvent[],
  year: number,
  month: number,
  opts: ResolvedOpts,
  logoMap: Map<string, string | null> | 'direct',
  faviconUrl: string | null
): string {
  const locale = getLocale();
  const monthLabel = new Intl.DateTimeFormat(locale, { month: 'long' })
    .format(new Date(year, month, 1))
    .replace(/^\w/, (c) => c.toUpperCase());

  const cells = buildCalendarCells(year, month);
  const nRows = cells.length / 7;
  // Divide the FULL container height across the rows (no cap): a 4-row month gets taller cells that
  // reach the bottom edge instead of leaving a white band, keeping the content A4-ratio exact.
  const CELL_H = Math.floor(
    (CALENDAR_CONTAINER_HEIGHT - HEADER_H - WEEKDAY_ROW_H - GRID_PAD_BOTTOM) / nRows
  );

  // Canva-style block shadow: a hard-offset duplicate of the text (0 blur radius), not a diffuse
  // drop-shadow. The offset is applied on both axes for a diagonal translation, in the chosen color.
  const blockShadow = opts.enableTextShadow
    ? `text-shadow:${opts.textShadowOffset}px ${opts.textShadowOffset}px 0 ${opts.textShadowColor};`
    : '';
  const labelShadow = blockShadow;
  const weekdayNames = localizedWeekdays(locale, opts.weekdayFullNames ? 'long' : 'short');
  // Full names are wider, so tighten letter-spacing and drop the font a touch to keep them on one line.
  const weekdayFontSize = opts.weekdayFullNames ? 11 : 12;
  const weekdayLetterSpacing = opts.weekdayFullNames ? '.02em' : '.09em';
  const headerRow = weekdayNames
    .map(
      (w, i) =>
        // The marker sits on the inner span, never on this padded box: the vector re-draw anchors a
        // run to the TOP of the marked element and knows nothing about padding, so marking the box
        // drew the label 11 px above where the preview shows it. Flex centring also makes the row
        // height explicit rather than padding-derived, which is what WEEKDAY_ROW_H already assumed.
        `<div style="height:${WEEKDAY_ROW_H}px;display:flex;align-items:center;justify-content:center;padding:0 6px;box-sizing:border-box;background:${opts.weekdayRowBg};"><span data-pdf-text style="text-align:center;font-size:${weekdayFontSize}px;font-weight:800;line-height:1;text-transform:uppercase;letter-spacing:${weekdayLetterSpacing};color:${i >= 5 ? opts.weekendLabelColor : opts.weekdayLabelColor};${labelShadow}">${w}</span></div>`
    )
    .join('');

  const cellBgNormal = hexToRgba(opts.cellBg, opts.cellBgOpacity);
  const cellBgWeekend = hexToRgba(opts.weekendCellBg, opts.weekendCellBgOpacity);
  // Empty (padding) cells are slightly more transparent so the bg image shows through more.
  const cellBgEmptyNormal = hexToRgba(opts.cellBg, Math.max(0, opts.cellBgOpacity - 12));
  const cellBgEmptyWeekend = hexToRgba(
    opts.weekendCellBg,
    Math.max(0, opts.weekendCellBgOpacity - 4)
  );

  const cellHtml = cells
    .map((day, i) => {
      const isWeekend = i % 7 >= 5;

      if (day === null) {
        return `<div style="height:${CELL_H}px;background:${isWeekend ? cellBgEmptyWeekend : cellBgEmptyNormal};border-right:1px solid ${opts.borderColor};border-bottom:1px solid ${opts.borderColor};box-sizing:border-box;"></div>`;
      }

      const dayEvents = eventsOnDay(events, year, month, day);
      const dayBreaks = breaksOnDay(events, year, month, day);
      const breakColor = dayBreaks.length > 0 ? eventHexColors(dayBreaks[0])[0] : null;
      // A 3px colored strip along the bottom edge, continuous across a break period.
      const breakBand = breakColor
        ? `<div style="position:absolute;bottom:0;left:0;right:0;height:3px;background:${breakColor};"></div>`
        : '';
      // A full-cell tint so a break reads across days behind events. Opacity is configurable so a
      // theme with a busy background image can strengthen it enough to stay visible.
      const breakTint = breakColor
        ? `<div style="position:absolute;inset:0;background:${breakColor};opacity:${(opts.breakTintOpacity / 100).toFixed(2)};pointer-events:none;"></div>`
        : '';

      if (dayEvents.length === 0) {
        const bg = isWeekend ? cellBgWeekend : cellBgNormal;
        const breakLabel = breakColor
          ? `<div data-pdf-text style="position:absolute;left:4px;right:4px;bottom:6px;text-align:center;font-size:9px;font-weight:800;color:${breakColor};line-height:1.15;overflow:hidden;">${safe(dayBreaks[0].title)}</div>`
          : '';
        return `<div style="position:relative;height:${CELL_H}px;background:${bg};border-right:1px solid ${opts.borderColor};border-bottom:1px solid ${opts.borderColor};box-sizing:border-box;padding:6px 7px;">${breakTint}<span data-pdf-text style="position:relative;font-size:12px;font-weight:700;color:${opts.emptyDayColor};">${day}</span>${breakLabel}${breakBand}</div>`;
      }

      const nVisible = dayEvents.length > MAX_SHOW ? MAX_SHOW - 1 : dayEvents.length;
      const visible = dayEvents.slice(0, nVisible);
      const overflowCount = dayEvents.length - nVisible;
      const nSlots = nVisible + (overflowCount > 0 ? 1 : 0);
      const slotH = Math.floor(CELL_H / nSlots);

      const rows = [
        ...visible.map((ev, idx) => {
          const bg = eventBgCss(ev);
          const fg = contrastColor(eventHexColors(ev)[0]);

          // Resolve logos (primary + co-owners): data URL map for PDF export, direct URL for preview.
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
          for (const [i, o] of owners.entries()) {
            if (logoSrcs[i] === null) {
              console.warn(
                `[CalendarExport] No logo for "${o.name}" on "${ev.title}" - its half stays empty (logoUrl: ${o.url ?? 'none set'})`
              );
            }
          }

          const logoSize = Math.max(Math.round(slotH * 0.62), 14);
          // Watermark stays absolute - decorative only, doesn't affect flow.
          const watermark = logoSrcs.every((s) => s === null)
            ? ''
            : owners.length === 1
              ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;"><img src="${logoSrcs[0]}" style="height:${logoSize}px;width:${logoSize}px;border-radius:50%;object-fit:cover;opacity:0.18;" /></div>`
              : splitLogoWatermark(logoSrcs, logoSize);

          const sep = idx > 0 ? 'border-top:1px solid rgba(0,0,0,0.10);' : '';

          if (idx === 0) {
            // First slot: day number on top, title below - flex column so html2canvas sees
            // explicit heights and doesn't collapse the text area (fixes bottom:0 rendering bug).
            const DAY_NUM_H = 20;
            const availH = slotH - DAY_NUM_H;
            const { fontSize, clampCss, ph } = fitEventText(availH);
            return `<div style="height:${slotH}px;position:relative;background:${bg};overflow:hidden;${sep};display:flex;flex-direction:column;box-sizing:border-box;">
              ${watermark}
              <div style="height:${DAY_NUM_H}px;flex-shrink:0;padding:5px 0 0 6px;position:relative;"><span data-pdf-text style="font-size:11px;font-weight:800;color:${fg};line-height:1;">${day}</span></div>
              <div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:0 ${ph}px 2px;box-sizing:border-box;position:relative;"><span style="font-size:${fontSize}px;font-weight:700;color:${fg};line-height:${EVENT_TITLE_LINE_HEIGHT};text-align:center;${blockShadow}${clampCss}">${safe(ev.title)}</span></div>
            </div>`;
          } else {
            // Subsequent slots: no day number, title fully centred.
            const { fontSize, clampCss, ph } = fitEventText(slotH);
            return `<div style="height:${slotH}px;position:relative;background:${bg};overflow:hidden;${sep};display:flex;align-items:center;justify-content:center;padding:0 ${ph}px;box-sizing:border-box;">
              ${watermark}
              <span style="font-size:${fontSize}px;font-weight:700;color:${fg};line-height:${EVENT_TITLE_LINE_HEIGHT};text-align:center;position:relative;${blockShadow}${clampCss}">${safe(ev.title)}</span>
            </div>`;
          }
        }),
        ...(overflowCount > 0
          ? (() => {
              return [
                `<div style="height:${slotH}px;background:${opts.pageBg};display:flex;align-items:center;justify-content:center;overflow:hidden;"><span data-pdf-text style="font-size:9px;font-weight:800;color:#607188;${blockShadow}">${safe(m.calendar_export_more_events({ count: overflowCount }))}</span></div>`,
              ];
            })()
          : []),
      ];

      return `<div style="position:relative;height:${CELL_H}px;overflow:hidden;border-right:1px solid ${opts.borderColor};border-bottom:1px solid ${opts.borderColor};box-sizing:border-box;">${breakTint}${rows.join('')}${breakBand}</div>`;
    })
    .join('');

  const bgOpacityVal = (opts.bgOpacity / 100).toFixed(2);
  // Optional dark scrim over the image so text stays legible on a busy full-bleed photo. Nested in
  // the same [data-full-bg] layer so the export's single height patch covers it too.
  const scrimLayer =
    opts.scrimOpacity > 0
      ? `<div style="position:absolute;inset:0;background:${opts.scrimColor};opacity:${(opts.scrimOpacity / 100).toFixed(2)};"></div>`
      : '';
  // Full-page background image behind everything, CROPPED to the sheet.
  //
  // This was an <img> with object-fit:cover in a div that had a width but no height - the height
  // was patched in JS after insertion, on the export path only. So the preview never got one, the
  // image fell back to its intrinsic ratio, and neither view was reliably cropped: the sheet showed
  // bands wherever the photo's aspect did not match A4. A CSS background on a box pinned to the
  // container (inset:0) is the same visual with none of that: cover crops against a box that always
  // has the sheet's exact dimensions, in both the preview and the export, and there is nothing left
  // to patch afterwards. It also survives rasterisation more predictably than object-fit, which the
  // DOM-to-SVG serialiser has to reproduce on an inline replaced element.
  //
  // The image layer carries the opacity and the scrim is its SIBLING, not its child: the scrim is a
  // legibility device over the photo and must not be faded along with it.
  const fullBgHtml = opts.bgDataUrl
    ? `<div data-full-bg style="position:absolute;inset:0;overflow:hidden;pointer-events:none;"><div style="position:absolute;inset:0;background-image:url('${opts.bgDataUrl}');background-size:cover;background-position:center;background-repeat:no-repeat;opacity:${bgOpacityVal};"></div>${scrimLayer}</div>`
    : '';

  const faviconHtml = faviconUrl
    ? `<img src="${faviconUrl}" style="position:absolute;top:18px;left:18px;height:32px;width:32px;object-fit:contain;opacity:0.85;" />`
    : '';

  return `
    ${fullBgHtml}
    <div style="position:relative;">
      <div style="height:${HEADER_H}px;position:relative;background:${opts.headerBg};border-bottom:1.5px solid ${opts.borderColor};">
        ${faviconHtml}
        <h1 data-pdf-text style="position:relative;font-family:'Fredoka Variable','Fredoka','Segoe UI',sans-serif;font-size:30px;font-weight:700;color:${opts.monthTitleColor};margin:0;line-height:${HEADER_H}px;text-align:center;letter-spacing:.01em;${blockShadow}">${safe(monthLabel)}</h1>
      </div>
      <div style="padding:0 20px ${GRID_PAD_BOTTOM}px;">
        <div style="display:grid;grid-template-columns:repeat(7,1fr);border:1.5px solid ${opts.gridOuterBorder};border-top:none;border-radius:0 0 8px 8px;overflow:hidden;">
          ${headerRow}${cellHtml}
        </div>
      </div>
    </div>`;
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
  const body = buildCalendarHtml(events, year, month, opts, 'direct', '/favicon.png');
  // Wrapper mirrors the export container exactly (width, background, font-family) so the two render
  // identically. box-sizing/margin/padding resets are inlined since there is no iframe stylesheet.
  // Square corners, like the export: the preview's job is to show the sheet that will print, so a
  // decorative radius belongs to the page chrome around it, never to the sheet itself.
  return `<div style="position:relative;width:${CALENDAR_CONTAINER_WIDTH}px;height:${CALENDAR_CONTAINER_HEIGHT}px;background:${opts.pageBg};font-family:'Nunito Variable','Nunito','Segoe UI',sans-serif;color:#111;overflow:hidden;box-sizing:border-box;">${body}</div>`;
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
  const [faviconDataUrl, ...resolvedLogos] = await Promise.all([
    fetchDataUrl('/favicon.png'),
    ...uniqueLogoUrls.map(fetchDataUrl),
  ]);
  const logoMap = new Map<string, string | null>(
    uniqueLogoUrls.map((url, i) => [url, resolvedLogos[i]])
  );

  const innerHtml = buildCalendarHtml(events, year, month, opts, logoMap, faviconDataUrl ?? null);

  const container = document.createElement('div');
  Object.assign(container.style, {
    position: 'absolute',
    top: '0',
    left: '-9999px',
    width: '1080px',
    height: `${CALENDAR_CONTAINER_HEIGHT}px`,
    background: opts.pageBg,
    color: '#111111',
    fontFamily: '"Nunito Variable", "Nunito", "Segoe UI", sans-serif',
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
      backgroundColor: opts.pageBg,
      fonts: [
        "700 30px 'Fredoka Variable'",
        "700 13px 'Nunito Variable'",
        "800 13px 'Nunito Variable'",
      ],
    });
  } finally {
    document.body.removeChild(container);
  }
}
