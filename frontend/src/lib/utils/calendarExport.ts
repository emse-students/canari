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

// Cell layout constants (px)
const CELL_H = 100; // total cell height
const DAY_ROW_H = 24; // day-number row height (top)
const CELL_PAD = 5; // padding top/bottom/sides
const MAX_SHOW = 3; // max visible event blocks per cell

function safe(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Seasonal Unsplash background images by 0-indexed month.
 * Pre-fetched as base64 data: URLs so html2canvas never encounters cross-origin images.
 */
const MONTH_BG_URLS: Record<number, string> = {
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
async function toDataUrl(url: string | null): Promise<string | null> {
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
 * Each cell's event blocks fill the available height proportionally (1 event = full height,
 * 2 events = half each, etc.). Association logos appear as large transparent watermarks inside
 * event blocks. A seasonal background image decorates the month header.
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

  // Pre-fetch all images as data: URLs to avoid html2canvas cross-origin issues
  const uniqueLogoUrls = [
    ...new Set(events.map((ev) => ev.associationLogoUrl).filter(Boolean) as string[]),
  ];
  const [bgDataUrl, ...resolvedLogos] = await Promise.all([
    toDataUrl(MONTH_BG_URLS[month] ?? null),
    ...uniqueLogoUrls.map(toDataUrl),
  ]);
  const logoMap = new Map<string, string | null>(
    uniqueLogoUrls.map((url, i) => [url, resolvedLogos[i]])
  );

  const cells = buildCalendarCells(year, month);

  const headerRow = WEEKDAYS.map(
    (w, i) =>
      `<div style="padding:7px 6px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:${i >= 5 ? '#9ca3af' : '#607188'};border-bottom:2px solid #d9e0ea;background:#f8fafc;">${w}</div>`
  ).join('');

  const cellHtml = cells
    .map((day, i) => {
      const isWeekend = i % 7 >= 5;
      const cellBg = isWeekend ? '#f1f5f9' : '#fff';

      if (day === null) {
        return `<div style="height:${CELL_H}px;background:${isWeekend ? '#f1f5f9' : '#f8fafc'};border-right:1px solid #e5e9ef;border-bottom:1px solid #e5e9ef;box-sizing:border-box;"></div>`;
      }

      const dayEvents = eventsOnDay(events, year, month, day);

      // If there is overflow, sacrifice the last visible slot for a "+N" mini-row
      const nVisible = dayEvents.length > MAX_SHOW ? MAX_SHOW - 1 : dayEvents.length;
      const visible = dayEvents.slice(0, nVisible);
      const overflowCount = dayEvents.length - nVisible;

      // Events area: full cell height minus day-number row and padding
      const eventsAreaH = CELL_H - DAY_ROW_H - CELL_PAD * 2;
      const MORE_ROW_H = overflowCount > 0 ? 14 : 0;
      const gapSum = nVisible > 1 ? (nVisible - 1) * 2 : 0;
      const eventH = nVisible > 0 ? Math.floor((eventsAreaH - MORE_ROW_H - gapSum) / nVisible) : 0;

      const dayNumStyle = `font-size:12px;font-weight:700;color:${dayEvents.length > 0 ? '#1e293b' : '#94a3b8'};display:inline-block;`;

      const eventBlocks = visible
        .map((ev) => {
          const bg = eventBgHex(ev);
          const fg = contrastColor(bg);
          const logoDataUrl = ev.associationLogoUrl
            ? (logoMap.get(ev.associationLogoUrl) ?? null)
            : null;
          // Logo as large transparent watermark on the right of the block
          const logoSize = Math.max(eventH - 2, 16);
          const logoTop = Math.max(Math.floor((eventH - logoSize) / 2), 0);
          const watermarkHtml = logoDataUrl
            ? `<img src="${logoDataUrl}" style="position:absolute;right:2px;top:${logoTop}px;height:${logoSize}px;width:${logoSize}px;object-fit:contain;opacity:0.18;" />`
            : '';
          const fontSize = eventH >= 28 ? 11 : eventH >= 20 ? 10 : 9;
          return `<div style="height:${eventH}px;position:relative;display:flex;align-items:center;background:${bg};color:${fg};font-size:${fontSize}px;font-weight:700;border-radius:4px;padding:0 6px;overflow:hidden;white-space:nowrap;box-sizing:border-box;">${watermarkHtml}<span style="position:relative;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${safe(ev.title)}</span></div>`;
        })
        .join('<div style="height:2px;"></div>');

      const moreHtml =
        overflowCount > 0
          ? `<div style="height:2px;"></div><div style="height:${MORE_ROW_H}px;display:flex;align-items:center;padding:0 4px;font-size:9px;font-weight:700;color:#607188;">+${overflowCount} autre${overflowCount > 1 ? 's' : ''}</div>`
          : '';

      return `<div style="height:${CELL_H}px;padding:${CELL_PAD}px;background:${cellBg};border-right:1px solid #e5e9ef;border-bottom:1px solid #e5e9ef;box-sizing:border-box;display:flex;flex-direction:column;gap:0;overflow:hidden;">
  <div style="height:${DAY_ROW_H}px;display:flex;align-items:center;flex-shrink:0;"><span style="${dayNumStyle}">${day}</span></div>
  <div style="flex:1;display:flex;flex-direction:column;min-height:0;">${eventBlocks}${moreHtml}</div>
</div>`;
    })
    .join('');

  // Header: seasonal background image (right half visible, white tint for readability)
  const headerBgHtml = bgDataUrl
    ? `<img src="${bgDataUrl}" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;opacity:0.3;" /><div style="position:absolute;top:0;left:0;width:65%;height:100%;background:rgba(255,255,255,0.85);"></div>`
    : '';

  const container = document.createElement('div');
  Object.assign(container.style, {
    position: 'absolute',
    top: '0',
    left: '-9999px',
    width: '1080px', // landscape A4 ≈ 1122px at 96dpi; 1080px leaves a small margin
    background: '#ffffff',
    padding: '28px 32px',
    color: '#111111',
    fontFamily: '"Nunito", "Segoe UI", sans-serif',
    boxSizing: 'border-box',
  });

  container.innerHTML = `
    <div style="position:relative;height:72px;margin-bottom:16px;border-bottom:2.5px solid #d9e0ea;overflow:hidden;border-radius:10px;">
      ${headerBgHtml}
      <div style="position:relative;display:flex;align-items:center;height:100%;padding:0 16px;">
        <h1 style="font-family:'Fredoka','Segoe UI',sans-serif;font-size:28px;font-weight:700;color:#122035;margin:0;">${safe(monthLabel)}</h1>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);">${headerRow}${cellHtml}</div>`;

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
      backgroundColor: '#ffffff',
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
