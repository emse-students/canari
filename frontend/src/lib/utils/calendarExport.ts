import { generateAvatarColor, getInitials } from './avatar';
import { contrastColor, toHex } from './color';
import type { AssociationCalendarFeedEvent } from '$lib/associations/api';

/**
 * Returns a guaranteed hex background color for an event.
 * html2canvas does not reliably render CSS `hsl()` backgrounds, so we always convert to hex.
 */
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
const MAX_VISIBLE = 4;

function safe(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Renders the monthly calendar grid to a landscape A4 PDF and triggers a direct download.
 * Uses html2canvas + jsPDF with PNG encoding for crisp text rendering.
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
      `<div style="padding:8px 6px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:${i >= 5 ? '#9ca3af' : '#607188'};border-bottom:2px solid #d9e0ea;background:#f8fafc;">${w}</div>`
  ).join('');

  const cellHtml = cells
    .map((day, i) => {
      const isWeekend = i % 7 >= 5;
      if (day === null) {
        return `<div style="min-height:88px;background:${isWeekend ? '#f1f5f9' : '#f8fafc'};border-right:1px solid #e5e9ef;border-bottom:1px solid #e5e9ef;"></div>`;
      }
      const dayEvents = eventsOnDay(events, year, month, day);
      const visible = dayEvents.slice(0, MAX_VISIBLE);
      const extra = dayEvents.length - MAX_VISIBLE;
      const today = sameDay(new Date(year, month, day), new Date());

      const eventBlocks = visible
        .map((ev) => {
          const bg = eventBgHex(ev);
          const fg = contrastColor(bg);
          // Logo or initials circle
          const logoHtml = ev.associationLogoUrl
            ? `<img src="${ev.associationLogoUrl}" style="width:14px;height:14px;border-radius:50%;object-fit:cover;flex-shrink:0;vertical-align:middle;" />`
            : `<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:rgba(255,255,255,0.25);font-size:7px;font-weight:900;color:${fg};flex-shrink:0;">${safe(getInitials(ev.associationName))}</span>`;
          return `<div style="display:flex;align-items:center;gap:4px;background:${bg};color:${fg};font-size:10px;font-weight:700;border-radius:4px;padding:3px 5px;margin-bottom:3px;overflow:hidden;white-space:nowrap;">${logoHtml}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safe(ev.title)}</span></div>`;
        })
        .join('');

      const extraHtml =
        extra > 0
          ? `<div style="font-size:9px;color:#607188;font-weight:600;padding-left:2px;">+${extra} autre${extra > 1 ? 's' : ''}</div>`
          : '';

      const dayNumStyle = today
        ? 'display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#f5c518;font-weight:900;font-size:12px;color:#111;margin-bottom:3px;'
        : `font-size:12px;font-weight:700;color:${dayEvents.length > 0 ? '#1e293b' : '#94a3b8'};margin-bottom:3px;display:inline-block;`;

      return `<div style="min-height:88px;padding:5px 6px;background:${isWeekend ? '#f8fafc' : '#fff'};border-right:1px solid #e5e9ef;border-bottom:1px solid #e5e9ef;display:flex;flex-direction:column;"><span style="${dayNumStyle}">${day}</span>${eventBlocks}${extraHtml}</div>`;
    })
    .join('');

  const container = document.createElement('div');
  Object.assign(container.style, {
    position: 'absolute',
    top: '0',
    // Landscape A4 at 96 DPI: 297mm × (96 / 25.4) ≈ 1122px
    left: '-9999px',
    width: '1080px',
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
    // Wait for all logo images to load before capturing
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

    // PNG for crisp text (no JPEG block artifacts on small text)
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

    const filename = `canari-agenda-${year}-${String(month + 1).padStart(2, '0')}`;
    pdf.save(`${filename}.pdf`);
  } finally {
    document.body.removeChild(container);
  }
}
