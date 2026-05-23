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

const CELL_H = 110; // total cell height px
const MAX_SHOW = 3; // max visible event slots per cell

function safe(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Seasonal Unsplash background images by 0-indexed month.
 * Pre-fetched as base64 data: URLs, then composited behind the calendar via Canvas API.
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
 * Draws a background image (cover crop) at low opacity on a canvas context.
 * Used to composite the seasonal image behind the calendar grid.
 */
function drawBgCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  opacity: number
) {
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const sw = img.naturalWidth * scale;
  const sh = img.naturalHeight * scale;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.drawImage(img, (w - sw) / 2, (h - sh) / 2, sw, sh);
  ctx.restore();
}

/**
 * Renders the monthly calendar grid to a landscape A4 PDF and triggers a direct download.
 *
 * Design:
 * - Events fill the entire cell height, split equally across all visible slots.
 * - Day number overlays the first event slot (or the empty cell), coloured for contrast.
 * - Association logos appear as large circular watermarks centred in each event slot.
 * - A seasonal background image is composited behind the calendar via the Canvas API
 *   (no html2canvas background-image dependency; cells with events are opaque,
 *   empty cells use rgba(255,255,255,0.85) so the image shows subtly through them).
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
    fetchDataUrl(MONTH_BG_URLS[month] ?? null),
    ...uniqueLogoUrls.map(fetchDataUrl),
  ]);
  const logoMap = new Map<string, string | null>(
    uniqueLogoUrls.map((url, i) => [url, resolvedLogos[i]])
  );

  const cells = buildCalendarCells(year, month);

  const headerRow = WEEKDAYS.map(
    (w, i) =>
      `<div style="padding:7px 6px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:${i >= 5 ? '#9ca3af' : '#607188'};border-bottom:2px solid #d9e0ea;background:rgba(248,250,252,0.92);">${w}</div>`
  ).join('');

  const cellHtml = cells
    .map((day, i) => {
      const isWeekend = i % 7 >= 5;

      if (day === null) {
        return `<div style="height:${CELL_H}px;background:${isWeekend ? 'rgba(241,245,249,0.7)' : 'rgba(248,250,252,0.7)'};border-right:1px solid rgba(229,233,239,0.8);border-bottom:1px solid rgba(229,233,239,0.8);box-sizing:border-box;"></div>`;
      }

      const dayEvents = eventsOnDay(events, year, month, day);

      if (dayEvents.length === 0) {
        const cellBg = isWeekend ? 'rgba(241,245,249,0.85)' : 'rgba(255,255,255,0.85)';
        return `<div style="height:${CELL_H}px;background:${cellBg};border-right:1px solid rgba(229,233,239,0.8);border-bottom:1px solid rgba(229,233,239,0.8);box-sizing:border-box;padding:5px 7px;"><span style="font-size:12px;font-weight:700;color:#94a3b8;">${day}</span></div>`;
      }

      // Events fill the entire cell, each slot gets an equal share of CELL_H
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

          // Circular logo watermark centred in the slot
          const logoSize = Math.max(Math.round(slotH * 0.64), 14);
          const watermark = logoDataUrl
            ? `<div style="position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;"><img src="${logoDataUrl}" style="height:${logoSize}px;width:${logoSize}px;border-radius:50%;object-fit:cover;opacity:0.18;" /></div>`
            : '';

          // Day number overlaid on the first slot only
          const dayNum =
            idx === 0
              ? `<span style="position:absolute;top:3px;left:5px;font-size:10px;font-weight:900;line-height:1;color:${fg};">${day}</span>`
              : '';

          const fontSize = slotH >= 40 ? 12 : slotH >= 28 ? 11 : slotH >= 20 ? 10 : 9;
          return `<div style="height:${slotH}px;position:relative;display:flex;align-items:center;justify-content:center;background:${bg};overflow:hidden;">${watermark}${dayNum}<span style="position:relative;font-size:${fontSize}px;font-weight:700;color:${fg};text-align:center;padding:0 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;box-sizing:border-box;">${safe(ev.title)}</span></div>`;
        }),
        ...(overflowCount > 0
          ? [
              `<div style="height:${slotH}px;display:flex;align-items:center;justify-content:center;background:rgba(241,245,249,0.9);"><span style="font-size:9px;font-weight:700;color:#607188;">+${overflowCount} autre${overflowCount > 1 ? 's' : ''}</span></div>`,
            ]
          : []),
      ];

      return `<div style="height:${CELL_H}px;overflow:hidden;border-right:1px solid rgba(229,233,239,0.8);border-bottom:1px solid rgba(229,233,239,0.8);box-sizing:border-box;display:flex;flex-direction:column;">${rows.join('')}</div>`;
    })
    .join('');

  const container = document.createElement('div');
  // No background on the container — we composite the bg image via Canvas API after rendering.
  // Cells use rgba backgrounds so they appear semi-transparent over the bg image.
  Object.assign(container.style, {
    position: 'absolute',
    top: '0',
    left: '-9999px',
    width: '1080px',
    color: '#111111',
    fontFamily: '"Nunito", "Segoe UI", sans-serif',
    boxSizing: 'border-box',
  });

  container.innerHTML = `
    <div style="padding:28px 32px;">
      <div style="margin-bottom:16px;padding-bottom:12px;border-bottom:2.5px solid rgba(217,224,234,0.9);">
        <h1 style="font-family:'Fredoka','Segoe UI',sans-serif;font-size:28px;font-weight:700;color:#122035;margin:0;display:inline-block;background:rgba(255,255,255,0.82);padding:4px 12px;border-radius:8px;">${safe(monthLabel)}</h1>
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);">${headerRow}${cellHtml}</div>
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

    // Render calendar to canvas with transparent background so rgba cells show through later
    const calCanvas = await html2canvas(container, {
      scale: 2,
      useCORS: false,
      backgroundColor: null,
      logging: false,
    });

    // Composite: bg image (cover, low opacity) → calendar grid on top
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = calCanvas.width;
    finalCanvas.height = calCanvas.height;
    const ctx = finalCanvas.getContext('2d')!;

    // Fill a light neutral base so empty-cell transparency looks clean
    ctx.fillStyle = '#eef2f7';
    ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);

    if (bgDataUrl) {
      const bgImg = new Image();
      await new Promise<void>((resolve) => {
        bgImg.onload = () => resolve();
        bgImg.onerror = () => resolve(); // graceful
        bgImg.src = bgDataUrl;
      });
      if (bgImg.naturalWidth > 0) {
        drawBgCover(ctx, bgImg, finalCanvas.width, finalCanvas.height, 0.45);
      }
    }

    // Draw calendar (cells with rgba backgrounds blend naturally with the bg image)
    ctx.drawImage(calCanvas, 0, 0);

    const imgData = finalCanvas.toDataURL('image/png');
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const imgH = (finalCanvas.height * pageW) / finalCanvas.width;

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
