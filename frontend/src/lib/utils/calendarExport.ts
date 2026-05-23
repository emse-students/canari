import { generateAvatarColor, getInitials } from './avatar';
import { contrastColor, toHex } from './color';
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
 * Renders the monthly calendar grid to a landscape A4 PDF and triggers a direct download.
 * Each cell's event blocks fill the available height proportionally (1 event = full height,
 * 2 events = half each, etc.). Uses PNG for crisp text.
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
      const today = sameDay(new Date(year, month, day), new Date());

      // If there is overflow, sacrifice the last visible slot for a "+N" mini-row
      const nVisible = dayEvents.length > MAX_SHOW ? MAX_SHOW - 1 : dayEvents.length;
      const visible = dayEvents.slice(0, nVisible);
      const overflowCount = dayEvents.length - nVisible;

      // Events area: full cell height minus day-number row and padding
      const eventsAreaH = CELL_H - DAY_ROW_H - CELL_PAD * 2;
      const MORE_ROW_H = overflowCount > 0 ? 14 : 0;
      const gapSum = nVisible > 1 ? (nVisible - 1) * 2 : 0;
      const eventH = nVisible > 0 ? Math.floor((eventsAreaH - MORE_ROW_H - gapSum) / nVisible) : 0;

      const dayNumStyle = today
        ? `display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#f5c518;font-weight:900;font-size:12px;color:#111;`
        : `font-size:12px;font-weight:700;color:${dayEvents.length > 0 ? '#1e293b' : '#94a3b8'};display:inline-block;`;

      const eventBlocks = visible
        .map((ev) => {
          const bg = eventBgHex(ev);
          const fg = contrastColor(bg);
          const logoHtml = ev.associationLogoUrl
            ? `<img src="${ev.associationLogoUrl}" style="width:${Math.min(eventH - 4, 18)}px;height:${Math.min(eventH - 4, 18)}px;border-radius:50%;object-fit:cover;flex-shrink:0;" />`
            : `<span style="display:inline-flex;align-items:center;justify-content:center;width:${Math.min(eventH - 4, 18)}px;height:${Math.min(eventH - 4, 18)}px;border-radius:50%;background:rgba(255,255,255,0.28);font-size:${Math.max(6, Math.min(eventH - 10, 9))}px;font-weight:900;color:${fg};flex-shrink:0;">${safe(getInitials(ev.associationName))}</span>`;
          const fontSize = eventH >= 28 ? 11 : eventH >= 20 ? 10 : 9;
          return `<div style="height:${eventH}px;display:flex;align-items:center;gap:4px;background:${bg};color:${fg};font-size:${fontSize}px;font-weight:700;border-radius:4px;padding:0 6px;overflow:hidden;white-space:nowrap;box-sizing:border-box;">${logoHtml}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${safe(ev.title)}</span></div>`;
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
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:12px;border-bottom:2.5px solid #d9e0ea;">
      <h1 style="font-family:'Fredoka','Segoe UI',sans-serif;font-size:26px;font-weight:700;color:#122035;margin:0;">${safe(monthLabel)}</h1>
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
