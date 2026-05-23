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

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function eventsOnDay(
  events: AssociationCalendarFeedEvent[],
  year: number,
  month: number,
  day: number
): AssociationCalendarFeedEvent[] {
  const d = new Date(year, month, day);
  return events
    .filter((ev) => sameDay(new Date(ev.startsAt), d))
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

const CELL_H = 130; // cell height px — taller for comfortable text
const MAX_SHOW = 3; // max visible event slots per cell

function safe(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Seasonal Unsplash background images by 0-indexed month.
 * Used as header background (data: URL, pre-fetched to avoid CORS).
 */
export const MONTH_BG_URLS: Record<number, string> = {
  0: 'https://images.unsplash.com/photo-1516912481808-3406841bd33c?w=1200&q=70&auto=format&fit=crop',
  1: 'https://images.unsplash.com/photo-1484589065579-a8f8a2adf0b4?w=1200&q=70&auto=format&fit=crop',
  2: 'https://images.unsplash.com/photo-1490750967868-88df5691cc53?w=1200&q=70&auto=format&fit=crop',
  3: 'https://images.unsplash.com/photo-1462275646964-a0e3386b89fa?w=1200&q=70&auto=format&fit=crop',
  4: 'https://images.unsplash.com/photo-1508739773434-c26b3d09e071?w=1200&q=70&auto=format&fit=crop',
  5: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1200&q=70&auto=format&fit=crop',
  6: 'https://images.unsplash.com/photo-1530053969600-caed2596d242?w=1200&q=70&auto=format&fit=crop',
  7: 'https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?w=1200&q=70&auto=format&fit=crop',
  8: 'https://images.unsplash.com/photo-1508193638397-1c4234db14d8?w=1200&q=70&auto=format&fit=crop',
  9: 'https://images.unsplash.com/photo-1508084699793-bb8ce8ce37b3?w=1200&q=70&auto=format&fit=crop',
  10: 'https://images.unsplash.com/photo-1472289065668-ce650ac443d2?w=1200&q=70&auto=format&fit=crop',
  11: 'https://images.unsplash.com/photo-1543589077-47d81606c1bf?w=1200&q=70&auto=format&fit=crop',
};

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
 * - Canari yellow (#f5c518) header with Fredoka font and seasonal background image.
 * - Dark navy (#122035) weekday header row with yellow weekend labels.
 * - Events fill the entire cell height, split equally across all visible slots.
 * - Day number is a small yellow badge overlaid on the first slot.
 * - Association logos appear as circular watermarks centred in each event slot.
 */
export async function exportCalendarMonth(
  events: AssociationCalendarFeedEvent[],
  focusDate: Date
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

  // Pre-fetch all images as data: URLs (cross-origin safe for html2canvas)
  const uniqueLogoUrls = [
    ...new Set(events.map((ev) => ev.associationLogoUrl).filter(Boolean) as string[]),
  ];
  const [bgDataUrl, ...resolvedLogos] = await Promise.all([
    fetchDataUrl(MONTH_BG_URLS[month] ?? null),
    ...uniqueLogoUrls.map(fetchDataUrl),
  ]);
  const logoMap = new Map<string, string | null>(
    uniqueLogoUrls.map((url, i) => [url, resolvedLogos[i]])
  );

  const cells = buildCalendarCells(year, month);

  // Dark navy weekday header: yellow labels for weekends, white for weekdays
  const headerRow = WEEKDAYS.map(
    (w, i) =>
      `<div style="padding:9px 6px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:${i >= 5 ? '#f5c518' : '#e2eaf4'};background:#122035;">${w}</div>`
  ).join('');

  const cellHtml = cells
    .map((day, i) => {
      const isWeekend = i % 7 >= 5;

      if (day === null) {
        return `<div style="height:${CELL_H}px;background:${isWeekend ? '#f1f5f9' : '#f8fafc'};border-right:1px solid #dde3ec;border-bottom:1px solid #dde3ec;box-sizing:border-box;"></div>`;
      }

      const dayEvents = eventsOnDay(events, year, month, day);

      if (dayEvents.length === 0) {
        const bg = isWeekend ? '#f1f5f9' : '#ffffff';
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

          // Same style as empty cells: plain number top-left, no badge
          const dayNum =
            idx === 0
              ? `<span style="position:absolute;top:6px;left:7px;font-size:12px;font-weight:700;color:${fg};z-index:1;">${day}</span>`
              : '';

          const fontSize = slotH >= 60 ? 13 : slotH >= 45 ? 12 : slotH >= 35 ? 11 : 10;

          // Vertical centering via padding-top (reliable in html2canvas, no flexbox dependency).
          // For tall slots allow wrapping; for short slots enforce single line via line-height.
          let textHtml: string;
          if (slotH >= 48) {
            const paddingTop = Math.max(4, Math.floor((slotH - fontSize * 1.3) / 2));
            textHtml = `<div style="position:absolute;top:0;left:0;width:100%;padding-top:${paddingTop}px;text-align:center;box-sizing:border-box;overflow:hidden;max-height:${slotH}px;"><span style="display:block;font-size:${fontSize}px;font-weight:700;color:${fg};word-break:break-word;line-height:1.3;padding:0 10px;box-sizing:border-box;">${safe(ev.title)}</span></div>`;
          } else {
            textHtml = `<div style="position:absolute;top:0;left:0;width:100%;height:${slotH}px;text-align:center;overflow:hidden;"><span style="display:block;font-size:${fontSize}px;font-weight:700;color:${fg};line-height:${slotH}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 6px;box-sizing:border-box;">${safe(ev.title)}</span></div>`;
          }

          return `<div style="height:${slotH}px;position:relative;background:${bg};overflow:hidden;">${watermark}${dayNum}${textHtml}</div>`;
        }),
        ...(overflowCount > 0
          ? [
              `<div style="height:${slotH}px;background:#f0f4f8;text-align:center;overflow:hidden;"><span style="display:block;font-size:9px;font-weight:800;color:#607188;line-height:${slotH}px;">+${overflowCount} autre${overflowCount > 1 ? 's' : ''}</span></div>`,
            ]
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
    background: '#f5f7fa',
    color: '#111111',
    fontFamily: '"Nunito", "Segoe UI", sans-serif',
    boxSizing: 'border-box',
    borderRadius: '12px',
    overflow: 'hidden',
  });

  // Seasonal image in the yellow header at 25% opacity (data: URL, no CORS issues)
  const headerImgHtml = bgDataUrl
    ? `<img src="${bgDataUrl}" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;opacity:0.25;" />`
    : '';

  container.innerHTML = `
    <!-- Canari yellow header with centred month title -->
    <div style="background:#f5c518;position:relative;overflow:hidden;height:84px;text-align:center;">
      ${headerImgHtml}
      <h1 style="position:relative;font-family:'Fredoka','Segoe UI',sans-serif;font-size:34px;font-weight:700;color:#122035;margin:0;line-height:84px;text-align:center;letter-spacing:.01em;">${safe(monthLabel)}</h1>
    </div>
    <!-- Calendar grid -->
    <div style="padding:0 20px 20px;">
      <div style="display:grid;grid-template-columns:repeat(7,1fr);border:1.5px solid #122035;border-top:none;border-radius:0 0 8px 8px;overflow:hidden;">
        ${headerRow}${cellHtml}
      </div>
    </div>`;

  document.body.appendChild(container);

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
    const pageH = pdf.internal.pageSize.getHeight();
    const imgH = (canvas.height * pageW) / canvas.width;

    if (imgH <= pageH) {
      pdf.addImage(imgData, 'PNG', 0, 0, pageW, imgH);
    } else {
      let yMm = 0;
      while (yMm < imgH) {
        if (yMm > 0) pdf.addPage();
        pdf.addImage(imgData, 'PNG', 0, -yMm, pageW, imgH);
        yMm += pageH;
      }
    }

    pdf.save(`canari-agenda-${year}-${String(month + 1).padStart(2, '0')}.pdf`);
  } finally {
    document.body.removeChild(container);
  }
}
