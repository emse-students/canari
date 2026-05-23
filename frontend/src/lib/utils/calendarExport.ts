import { generateAvatarColor } from './avatar';
import { contrastColor } from './color';
import type { AssociationCalendarFeedEvent } from '$lib/associations/api';

/** Returns the effective background color for an event (hex preferred, HSL fallback). */
function eventBgColor(ev: AssociationCalendarFeedEvent): string {
  return ev.associationColor ?? generateAvatarColor(ev.associationId);
}

/** Returns a readable text color for the given background (hex or HSL). */
function eventTextColor(bg: string): string {
  return bg.startsWith('#') ? contrastColor(bg) : '#ffffff';
}

/** Monday-first array of day numbers (null = padding cell) for a given month. */
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
) {
  const d = new Date(year, month, day);
  return events
    .filter((ev) => sameDay(new Date(ev.startsAt), d))
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const MAX_VISIBLE = 4;

function safe(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Renders the monthly calendar grid to an A4 PDF and triggers a direct download.
 * Uses html2canvas + jsPDF; no new tab or print dialog.
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
    (w) =>
      `<div style="padding:6px 4px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#607188;border-bottom:1.5px solid #d9e0ea;">${w}</div>`
  ).join('');

  const cellHtml = cells
    .map((day) => {
      if (day === null) {
        return `<div style="min-height:72px;background:#f7f9fc;border:1px solid #e5e9ef;"></div>`;
      }
      const dayEvents = eventsOnDay(events, year, month, day);
      const visible = dayEvents.slice(0, MAX_VISIBLE);
      const extra = dayEvents.length - MAX_VISIBLE;
      const eventBlocks = visible
        .map((ev) => {
          const bg = eventBgColor(ev);
          const fg = eventTextColor(bg);
          return `<div style="background:${bg};color:${fg};font-size:9px;font-weight:600;border-radius:3px;padding:1px 4px;margin-bottom:2px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" title="${safe(ev.title)} — ${safe(ev.associationName)}">${safe(ev.title)}</div>`;
        })
        .join('');
      const extraHtml =
        extra > 0
          ? `<div style="font-size:9px;color:#607188;font-weight:600;padding-left:2px;">+${extra} autre${extra > 1 ? 's' : ''}</div>`
          : '';
      const today = sameDay(new Date(year, month, day), new Date());
      const dayNumStyle = today
        ? 'display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#f5c518;font-weight:800;font-size:11px;color:#111;'
        : 'font-size:11px;font-weight:700;color:#607188;';
      return `<div style="min-height:72px;padding:4px 5px;background:#fff;border:1px solid #e5e9ef;display:flex;flex-direction:column;gap:2px;"><span style="${dayNumStyle}">${day}</span>${eventBlocks}${extraHtml}</div>`;
    })
    .join('');

  const container = document.createElement('div');
  Object.assign(container.style, {
    position: 'absolute',
    top: '0',
    left: '-9999px',
    width: '794px',
    background: '#ffffff',
    padding: '32px 36px',
    color: '#111111',
    fontFamily: '"Nunito", "Segoe UI", sans-serif',
    boxSizing: 'border-box',
  });

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;padding-bottom:14px;border-bottom:2px solid #d9e0ea;">
      <h1 style="font-family:'Fredoka','Segoe UI',sans-serif;font-size:24px;font-weight:700;color:#122035;margin:0;">${safe(monthLabel)}</h1>
    </div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:0;">${headerRow}${cellHtml}</div>`;

  document.body.appendChild(container);

  try {
    await document.fonts.ready;

    const canvas = await html2canvas(container, {
      scale: 2,
      useCORS: false,
      backgroundColor: '#ffffff',
      logging: false,
    });

    const imgData = canvas.toDataURL('image/jpeg', 0.92);
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const imgH = (canvas.height * pageW) / canvas.width;

    if (imgH <= pageH) {
      pdf.addImage(imgData, 'JPEG', 0, 0, pageW, imgH);
    } else {
      let yMm = 0;
      while (yMm < imgH) {
        if (yMm > 0) pdf.addPage();
        pdf.addImage(imgData, 'JPEG', 0, -yMm, pageW, imgH);
        yMm += pageH;
      }
    }

    const filename = `canari-agenda-${year}-${String(month + 1).padStart(2, '0')}`;
    pdf.save(`${filename}.pdf`);
  } finally {
    document.body.removeChild(container);
  }
}
