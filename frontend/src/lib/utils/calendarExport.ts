import { contrastColor, toHex } from './color';
import { generateAvatarColor } from './avatar';
import type { AssociationCalendarFeedEvent } from '$lib/associations/api';

/** Returns a guaranteed hex background color (html2canvas does not render hsl() reliably). */
function eventBgHex(ev: AssociationCalendarFeedEvent): string {
  return toHex(ev.associationColor ?? generateAvatarColor(ev.associationId));
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

const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

// CELL_H is computed per-export from the number of calendar rows (see exportCalendarMonth).
// These constants describe the non-cell vertical space in the container (px):
const HEADER_H = 68; // fixed top header
const WEEKDAY_ROW_H = 40; // weekday label row (11px pad × 2 + ~18px line-height, +1 safety)
const GRID_PAD_BOTTOM = 20; // padding:0 20px 20px on the grid wrapper
// A4 landscape at 1080px logical width: max container height before the image overflows the page.
// 210 × (1080/297) = 763px; subtract 5px safety margin for sub-pixel rounding.
const A4_MAX_CONTAINER_H = Math.floor((210 * 1080) / 297) - 5; // ≈ 758px
const MAX_CELL_H = 130; // aesthetic upper bound — prevents cells becoming too tall on short months
const MAX_SHOW = 3; // max visible event slots per cell

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
 * Renders the monthly calendar grid to a landscape A4 PDF and triggers a direct download.
 *
 * Design language:
 * - Optional background image at 14% opacity (caller-supplied base64 data URL, no CORS).
 * - Minimal header: Canari favicon top-left, month title centred in Fredoka.
 * - Dark navy (#122035) weekday row with yellow weekend labels.
 * - Events fill the entire cell height, split equally; subtle top border separates stacked slots.
 * - Text centred via padding-top + natural line-height:1.4 (no overflow:hidden on wrappers —
 *   avoids html2canvas clipping descenders; −2 px bias corrects apparent downward visual weight).
 * - Association logos appear as circular watermarks centred in each event slot.
 */
export async function exportCalendarMonth(
  events: AssociationCalendarFeedEvent[],
  focusDate: Date,
  /** Optional background image as a base64 data URL. Pass null for no background. */
  bgDataUrl: string | null = null
): Promise<void> {
  const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);

  const year = focusDate.getFullYear();
  const month = focusDate.getMonth();
  const monthLabel = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' })
    .format(focusDate)
    .replace(/^\w/, (c) => c.toUpperCase());

  // Pre-fetch logos as data: URLs (cross-origin safe for html2canvas)
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

  const cells = buildCalendarCells(year, month);
  // Compute the tallest cell height that keeps the calendar on a single A4 landscape page.
  const nRows = cells.length / 7;
  const CELL_H = Math.min(
    MAX_CELL_H,
    Math.floor((A4_MAX_CONTAINER_H - HEADER_H - WEEKDAY_ROW_H - GRID_PAD_BOTTOM) / nRows)
  );

  // Dark navy weekday header row
  const headerRow = WEEKDAYS.map(
    (w, i) =>
      `<div style="padding:11px 6px;text-align:center;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.09em;color:${i >= 5 ? '#f5c518' : '#c8d8eb'};background:#122035;">${w}</div>`
  ).join('');

  const cellHtml = cells
    .map((day, i) => {
      const isWeekend = i % 7 >= 5;

      if (day === null) {
        // Semi-transparent so the background image shows through
        return `<div style="height:${CELL_H}px;background:${isWeekend ? 'rgba(241,245,249,0.88)' : 'rgba(248,250,252,0.80)'};border-right:1px solid #dde3ec;border-bottom:1px solid #dde3ec;box-sizing:border-box;"></div>`;
      }

      const dayEvents = eventsOnDay(events, year, month, day);

      if (dayEvents.length === 0) {
        const bg = isWeekend ? 'rgba(241,245,249,0.92)' : 'rgba(255,255,255,0.92)';
        return `<div style="height:${CELL_H}px;background:${bg};border-right:1px solid #dde3ec;border-bottom:1px solid #dde3ec;box-sizing:border-box;padding:6px 7px;"><span style="font-size:12px;font-weight:700;color:#b8c4d0;">${day}</span></div>`;
      }

      // Events fill the entire cell, each slot an equal share of CELL_H
      const nVisible = dayEvents.length > MAX_SHOW ? MAX_SHOW - 1 : dayEvents.length;
      const visible = dayEvents.slice(0, nVisible);
      const overflowCount = dayEvents.length - nVisible;
      const nSlots = nVisible + (overflowCount > 0 ? 1 : 0);
      const slotH = Math.floor(CELL_H / nSlots);

      const rows = [
        ...visible.map((ev, idx) => {
          const bg = eventBgHex(ev);
          const fg = contrastColor(bg);
          const logoDataUrl = ev.associationLogoUrl
            ? (logoMap.get(ev.associationLogoUrl) ?? null)
            : null;

          const logoSize = Math.max(Math.round(slotH * 0.62), 14);
          const watermark = logoDataUrl
            ? `<div style="position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;pointer-events:none;"><img src="${logoDataUrl}" style="height:${logoSize}px;width:${logoSize}px;border-radius:50%;object-fit:cover;opacity:0.18;" /></div>`
            : '';

          const dayNum =
            idx === 0
              ? `<span style="position:absolute;top:6px;left:7px;font-size:12px;font-weight:700;color:${fg};z-index:1;">${day}</span>`
              : '';

          const fontSize = slotH >= 60 ? 13 : slotH >= 45 ? 12 : slotH >= 35 ? 11 : 10;

          // Text centering: padding-top positions the text; line-height:1.4 gives enough room
          // for ascenders AND descenders without relying on overflow:hidden inside the wrapper.
          // Only the outer slot div (overflow:hidden;height:slotH) provides clipping.
          // Subtract 2px to compensate for descender visual weight pushing the apparent centre down.
          const lineH = fontSize * 1.4;
          const paddingTop = Math.max(4, Math.floor((slotH - lineH) / 2) - 2);
          const wrap = slotH >= 48 ? 'word-break:break-word;' : 'white-space:nowrap;';
          const ph = slotH >= 48 ? 10 : 6;
          const textHtml = `<div style="position:absolute;top:0;left:0;width:100%;padding-top:${paddingTop}px;text-align:center;box-sizing:border-box;"><span style="display:block;font-size:${fontSize}px;font-weight:700;color:${fg};line-height:1.4;${wrap}padding:0 ${ph}px;box-sizing:border-box;">${safe(ev.title)}</span></div>`;

          // Subtle top border between stacked events (not on first slot)
          const sep = idx > 0 ? 'border-top:1px solid rgba(0,0,0,0.10);' : '';
          return `<div style="height:${slotH}px;position:relative;background:${bg};overflow:hidden;${sep}">${watermark}${dayNum}${textHtml}</div>`;
        }),
        ...(overflowCount > 0
          ? (() => {
              const pt = Math.max(4, Math.floor((slotH - 9 * 1.4) / 2));
              return [
                `<div style="height:${slotH}px;background:#f0f4f8;text-align:center;padding-top:${pt}px;box-sizing:border-box;overflow:hidden;"><span style="font-size:9px;font-weight:800;color:#607188;line-height:1.4;">+${overflowCount} autre${overflowCount > 1 ? 's' : ''}</span></div>`,
              ];
            })()
          : []),
      ];

      return `<div style="height:${CELL_H}px;overflow:hidden;border-right:1px solid #dde3ec;border-bottom:1px solid #dde3ec;box-sizing:border-box;">${rows.join('')}</div>`;
    })
    .join('');

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

  // Full-page seasonal background image behind everything.
  // bottom:0 does not stretch on auto-height containers — height is patched in JS after DOM insertion.
  const fullBgHtml = bgDataUrl
    ? `<div data-full-bg style="position:absolute;top:0;left:0;width:100%;pointer-events:none;"><img src="${bgDataUrl}" style="width:100%;height:100%;object-fit:cover;opacity:0.14;" /></div>`
    : '';

  // Favicon logo top-left of the header; centred month title via line-height.
  const logoHtml = faviconDataUrl
    ? `<img src="${faviconDataUrl}" style="position:absolute;top:18px;left:18px;height:32px;width:32px;object-fit:contain;opacity:0.85;" />`
    : '';

  container.innerHTML = `
    ${fullBgHtml}
    <!-- Content wrapper sits above the full-page background image -->
    <div style="position:relative;">
      <!-- Minimal header: logo left, month title centred -->
      <div style="height:68px;position:relative;border-bottom:1.5px solid #dde3ec;">
        ${logoHtml}
        <h1 style="position:relative;font-family:'Fredoka','Segoe UI',sans-serif;font-size:30px;font-weight:700;color:#122035;margin:0;line-height:68px;text-align:center;letter-spacing:.01em;">${safe(monthLabel)}</h1>
      </div>
      <!-- Calendar grid -->
      <div style="padding:0 20px 20px;">
        <div style="display:grid;grid-template-columns:repeat(7,1fr);border:1.5px solid #122035;border-top:none;border-radius:0 0 8px 8px;overflow:hidden;">
          ${headerRow}${cellHtml}
        </div>
      </div>
    </div>`;

  document.body.appendChild(container);

  // Patch background div height now that the container has a real rendered height.
  if (bgDataUrl) {
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

    // Scale to fill the full page width; CELL_H was sized to guarantee the image fits the height.
    pdf.addImage(imgData, 'PNG', 0, 0, pageW, (canvas.height * pageW) / canvas.width);

    pdf.save(`canari-agenda-${year}-${String(month + 1).padStart(2, '0')}.pdf`);
  } finally {
    document.body.removeChild(container);
  }
}
