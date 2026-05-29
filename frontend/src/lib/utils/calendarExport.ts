import { contrastColor, toHex } from './color';
import { generateAvatarColor } from './avatar';
import type { AssociationCalendarFeedEvent } from '$lib/associations/api';

const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const HEADER_H = 68;
const WEEKDAY_ROW_H = 40;
const GRID_PAD_BOTTOM = 20;
/** Height of the A4 landscape calendar container in pixels (1080px logical width). */
export const CALENDAR_CONTAINER_HEIGHT = Math.floor((210 * 1080) / 297) - 5; // ≈ 758
const MAX_CELL_H = 130;
const MAX_SHOW = 3;

/** Configurable visual options for the monthly calendar PDF export. */
export interface CalendarExportOptions {
  /** Base64 data: URL for the full-page background image. */
  bgDataUrl?: string | null;
  /** Background image opacity in percent (0–100). Default: 14. */
  bgOpacity?: number;
  /** Header bar background color (hex). Default: '#122035'. */
  headerBg?: string;
  /** Month title text color (hex). Default: '#122035'. */
  monthTitleColor?: string;
  /** Weekday row background color (hex). Default: '#122035'. */
  weekdayRowBg?: string;
  /** Mon–Fri label color (hex). Default: '#c8d8eb'. */
  weekdayLabelColor?: string;
  /** Sat–Sun label color (hex). Default: '#f5c518'. */
  weekendLabelColor?: string;
  /** Normal day cell background color (hex). Default: '#ffffff'. */
  cellBg?: string;
  /** Normal day cell background opacity in percent (0–100). Default: 92. */
  cellBgOpacity?: number;
  /** Weekend cell background color (hex). Default: '#f1f5f9'. */
  weekendCellBg?: string;
  /** Weekend cell background opacity in percent (0–100). Default: 92. */
  weekendCellBgOpacity?: number;
  /** Cell border color (hex). Default: '#dde3ec'. */
  borderColor?: string;
  /** Grid outer border color (hex). Default: '#122035'. */
  gridOuterBorder?: string;
  /** Day number color on event-free cells (hex). Default: '#b8c4d0'. */
  emptyDayColor?: string;
  /** Add a drop-shadow to the month title and weekday labels. Default: false. */
  enableTextShadow?: boolean;
}

/** Default values matching the original hardcoded design. */
export const DEFAULT_EXPORT_OPTIONS: Required<Omit<CalendarExportOptions, 'bgDataUrl'>> = {
  bgOpacity: 14,
  // Original design: no extra background on the header bar - it inherits the container bg (#f0f4f8).
  headerBg: '#f0f4f8',
  monthTitleColor: '#122035',
  weekdayRowBg: '#122035',
  weekdayLabelColor: '#c8d8eb',
  weekendLabelColor: '#f5c518',
  cellBg: '#ffffff',
  cellBgOpacity: 92,
  weekendCellBg: '#f1f5f9',
  weekendCellBgOpacity: 92,
  borderColor: '#dde3ec',
  gridOuterBorder: '#122035',
  emptyDayColor: '#b8c4d0',
  enableTextShadow: false,
};

type ResolvedOpts = Required<CalendarExportOptions>;

function hexToRgba(hex: string, opacityPct: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${(opacityPct / 100).toFixed(2)})`;
}

/** Returns all hex colors for an event: primary first, then co-owners. */
function eventHexColors(ev: AssociationCalendarFeedEvent): string[] {
  const primary = toHex(ev.associationColor ?? generateAvatarColor(ev.associationId));
  return [
    primary,
    ...(ev.coOwners ?? []).map((co) => toHex(co.color ?? generateAvatarColor(co.associationId))),
  ];
}

/** CSS background value for an event slot - solid hex or inline gradient for co-owned events. */
function eventBgCss(ev: AssociationCalendarFeedEvent): string {
  const colors = eventHexColors(ev);
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

function eventsOnDay(
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

function safe(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
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
  const monthLabel = new Intl.DateTimeFormat('fr-FR', { month: 'long' })
    .format(new Date(year, month, 1))
    .replace(/^\w/, (c) => c.toUpperCase());

  const cells = buildCalendarCells(year, month);
  const nRows = cells.length / 7;
  const CELL_H = Math.min(
    MAX_CELL_H,
    Math.floor((CALENDAR_CONTAINER_HEIGHT - HEADER_H - WEEKDAY_ROW_H - GRID_PAD_BOTTOM) / nRows)
  );

  const labelShadow = opts.enableTextShadow ? 'text-shadow:0 1px 5px rgba(0,0,0,0.4);' : '';
  const headerRow = WEEKDAYS.map(
    (w, i) =>
      `<div style="padding:11px 6px;text-align:center;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.09em;color:${i >= 5 ? opts.weekendLabelColor : opts.weekdayLabelColor};background:${opts.weekdayRowBg};${labelShadow}">${w}</div>`
  ).join('');

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

      if (dayEvents.length === 0) {
        const bg = isWeekend ? cellBgWeekend : cellBgNormal;
        return `<div style="height:${CELL_H}px;background:${bg};border-right:1px solid ${opts.borderColor};border-bottom:1px solid ${opts.borderColor};box-sizing:border-box;padding:6px 7px;"><span style="font-size:12px;font-weight:700;color:${opts.emptyDayColor};">${day}</span></div>`;
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

          // Resolve logo: data URL map for PDF export, direct URL for preview.
          const logoSrc = ev.associationLogoUrl
            ? logoMap === 'direct'
              ? ev.associationLogoUrl
              : (logoMap.get(ev.associationLogoUrl) ?? null)
            : null;

          const logoSize = Math.max(Math.round(slotH * 0.62), 14);
          // Watermark stays absolute - decorative only, doesn't affect flow.
          const watermark = logoSrc
            ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;"><img src="${logoSrc}" style="height:${logoSize}px;width:${logoSize}px;border-radius:50%;object-fit:cover;opacity:0.18;" /></div>`
            : '';

          const sep = idx > 0 ? 'border-top:1px solid rgba(0,0,0,0.10);' : '';

          if (idx === 0) {
            // First slot: day number on top, title below - flex column so html2canvas sees
            // explicit heights and doesn't collapse the text area (fixes bottom:0 rendering bug).
            const DAY_NUM_H = 20;
            const availH = slotH - DAY_NUM_H;
            const fontSize = availH >= 52 ? 13 : availH >= 38 ? 12 : availH >= 28 ? 11 : 10;
            const maxLines = Math.max(1, Math.floor(availH / (fontSize * 1.5)));
            const ph = availH >= 40 ? 8 : 5;
            const clampCss =
              maxLines === 1
                ? 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
                : `display:-webkit-box;-webkit-line-clamp:${maxLines};-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;`;
            return `<div style="height:${slotH}px;position:relative;background:${bg};overflow:hidden;${sep};display:flex;flex-direction:column;box-sizing:border-box;">
              ${watermark}
              <div style="height:${DAY_NUM_H}px;flex-shrink:0;padding:5px 0 0 6px;position:relative;"><span style="font-size:11px;font-weight:800;color:${fg};line-height:1;">${day}</span></div>
              <div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:0 ${ph}px 2px;box-sizing:border-box;position:relative;"><span style="font-size:${fontSize}px;font-weight:700;color:${fg};line-height:1.3;text-align:center;${clampCss}">${safe(ev.title)}</span></div>
            </div>`;
          } else {
            // Subsequent slots: no day number, title fully centred.
            const availH = slotH;
            const fontSize = availH >= 52 ? 13 : availH >= 38 ? 12 : availH >= 28 ? 11 : 10;
            const maxLines = Math.max(1, Math.floor(availH / (fontSize * 1.5)));
            const ph = availH >= 40 ? 8 : 5;
            const clampCss =
              maxLines === 1
                ? 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
                : `display:-webkit-box;-webkit-line-clamp:${maxLines};-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;`;
            return `<div style="height:${slotH}px;position:relative;background:${bg};overflow:hidden;${sep};display:flex;align-items:center;justify-content:center;padding:0 ${ph}px;box-sizing:border-box;">
              ${watermark}
              <span style="font-size:${fontSize}px;font-weight:700;color:${fg};line-height:1.3;text-align:center;position:relative;${clampCss}">${safe(ev.title)}</span>
            </div>`;
          }
        }),
        ...(overflowCount > 0
          ? (() => {
              return [
                `<div style="height:${slotH}px;background:#f0f4f8;display:flex;align-items:center;justify-content:center;overflow:hidden;"><span style="font-size:9px;font-weight:800;color:#607188;">+${overflowCount} autre${overflowCount > 1 ? 's' : ''}</span></div>`,
              ];
            })()
          : []),
      ];

      return `<div style="height:${CELL_H}px;overflow:hidden;border-right:1px solid ${opts.borderColor};border-bottom:1px solid ${opts.borderColor};box-sizing:border-box;">${rows.join('')}</div>`;
    })
    .join('');

  const bgOpacityVal = (opts.bgOpacity / 100).toFixed(2);
  // Full-page background image behind everything.
  // Height is patched in JS after DOM insertion for the export path.
  const fullBgHtml = opts.bgDataUrl
    ? `<div data-full-bg style="position:absolute;top:0;left:0;width:100%;pointer-events:none;"><img src="${opts.bgDataUrl}" style="width:100%;height:100%;object-fit:cover;opacity:${bgOpacityVal};" /></div>`
    : '';

  const faviconHtml = faviconUrl
    ? `<img src="${faviconUrl}" style="position:absolute;top:18px;left:18px;height:32px;width:32px;object-fit:contain;opacity:0.85;" />`
    : '';

  return `
    ${fullBgHtml}
    <div style="position:relative;">
      <div style="height:${HEADER_H}px;position:relative;background:${opts.headerBg};border-bottom:1.5px solid ${opts.borderColor};">
        ${faviconHtml}
        <h1 style="position:relative;font-family:'Fredoka','Segoe UI',sans-serif;font-size:30px;font-weight:700;color:${opts.monthTitleColor};margin:0;line-height:${HEADER_H}px;text-align:center;letter-spacing:.01em;${opts.enableTextShadow ? 'text-shadow:0 2px 10px rgba(0,0,0,0.18);' : ''}">${safe(monthLabel)}</h1>
      </div>
      <div style="padding:0 20px ${GRID_PAD_BOTTOM}px;">
        <div style="display:grid;grid-template-columns:repeat(7,1fr);border:1.5px solid ${opts.gridOuterBorder};border-top:none;border-radius:0 0 8px 8px;overflow:hidden;">
          ${headerRow}${cellHtml}
        </div>
      </div>
    </div>`;
}

/**
 * Builds a complete standalone HTML document for use as an `<iframe srcdoc>` live preview.
 * Uses direct logo URLs (same-origin iframe - no CORS issue) and loads Google Fonts so the
 * preview fonts match the exported PDF.
 */
export function buildPreviewDocument(
  events: AssociationCalendarFeedEvent[],
  year: number,
  month: number,
  options: CalendarExportOptions = {}
): string {
  const opts: ResolvedOpts = { ...DEFAULT_EXPORT_OPTIONS, bgDataUrl: null, ...options };
  const body = buildCalendarHtml(events, year, month, opts, 'direct', '/favicon.png');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@700&family=Nunito:wght@700;800&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0;}body{background:#f0f4f8;font-family:'Nunito','Segoe UI',sans-serif;color:#111;}</style>
</head><body><div style="position:relative;width:1080px;background:#f0f4f8;border-radius:12px;overflow:hidden;">${body}</div></body></html>`;
}

/**
 * Renders the monthly calendar grid to a landscape A4 PDF and triggers a direct download.
 *
 * - Optional background image at configurable opacity.
 * - All colours are fully configurable via `options`; defaults match the original design.
 * - Association logos appear as circular watermarks (pre-fetched as data: URLs for html2canvas).
 */
export async function exportCalendarMonth(
  events: AssociationCalendarFeedEvent[],
  focusDate: Date,
  options: CalendarExportOptions = {}
): Promise<void> {
  const opts: ResolvedOpts = { ...DEFAULT_EXPORT_OPTIONS, bgDataUrl: null, ...options };

  const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);

  const year = focusDate.getFullYear();
  const month = focusDate.getMonth();

  const uniqueLogoUrls = [
    ...new Set(events.map((ev) => ev.associationLogoUrl).filter(Boolean) as string[]),
  ];
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
    background: '#f0f4f8',
    color: '#111111',
    fontFamily: '"Nunito", "Segoe UI", sans-serif',
    boxSizing: 'border-box',
    borderRadius: '12px',
    overflow: 'hidden',
  });

  container.innerHTML = innerHtml;
  document.body.appendChild(container);

  // Patch background div height now that the container has a real rendered height.
  if (opts.bgDataUrl) {
    const bgEl = container.querySelector<HTMLElement>('[data-full-bg]');
    if (bgEl) bgEl.style.height = container.offsetHeight + 'px';
  }

  try {
    await Promise.all(
      Array.from(container.querySelectorAll<HTMLImageElement>('img')).map(
        (img) =>
          new Promise<void>((resolve) => {
            if (img.complete) resolve();
            else {
              img.onload = () => resolve();
              img.onerror = () => resolve();
            }
          })
      )
    );

    await document.fonts.ready;

    const canvas = await html2canvas(container, {
      scale: 2,
      useCORS: false,
      backgroundColor: '#f5f7fa',
      logging: false,
    });

    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    pdf.addImage(imgData, 'PNG', 0, 0, pageW, (canvas.height * pageW) / canvas.width);
    pdf.save(`canari-agenda-${year}-${String(month + 1).padStart(2, '0')}.pdf`);
  } finally {
    document.body.removeChild(container);
  }
}
