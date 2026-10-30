import { describe, expect, it } from 'vitest';
import {
  fromStoredLines,
  MAX_AVAILABILITY_LINES,
  toStoredLines,
  wholeDaysInARow,
  type EditorLine,
} from './availability';
import {
  applyTemplate,
  editRun,
  editSlot,
  formatRuns,
  isOpenAt,
  modeFrom,
  paintRows,
  paintSlotRows,
  rowsOfWeek,
  slotLengthFor,
  slotLengthOf,
  slotStep,
  weekSlotsOf,
  templatePreview,
  templateWeek,
  weekRunsOf,
} from './availabilityPaint';

const weekly = (weekday: number, start: string, end: string): EditorLine => ({
  kind: 'weekly',
  weekday: weekday as 1,
  start,
  end,
});
const dated = (date: string, start: string, end: string): EditorLine => ({
  kind: 'dated',
  date,
  start,
  end,
});

/** The stored lines of rows, sorted, so two orders of the same hours compare equal. */
const stored = (rows: readonly EditorLine[]) =>
  toStoredLines(rows)
    .map((l) => `${l.weekday ?? l.onDate} ${l.startTime}-${l.endTime}`)
    .sort();

describe('the week as runs (WP-R4, D49)', () => {
  it('reads weekly lines per weekday, merged, and leaves dated lines out', () => {
    const week = weekRunsOf([
      weekly(1, '08:00', '12:00'),
      weekly(1, '12:00', '18:00'),
      weekly(2, '09:00', '10:00'),
      dated('2026-11-12', '14:00', '18:45'),
    ]);
    expect(week[0]).toEqual([[480, 1080]]);
    expect(week[1]).toEqual([[540, 600]]);
    expect(week[2]).toEqual([]);
  });

  it('reads a line crossing midnight as its two halves, on two days', () => {
    const week = weekRunsOf([weekly(5, '22:00', '02:00')]);
    expect(week[4]).toEqual([[1320, 1440]]);
    expect(week[5]).toEqual([[0, 120]]);
  });

  it('writes a night back as ONE line, and a Sunday night wraps onto Monday', () => {
    const rows = rowsOfWeek(weekRunsOf([weekly(7, '22:00', '02:00')]), []);
    expect(rows).toEqual([weekly(7, '22:00', '02:00')]);
  });

  it('round-trips a typical set of lines to the same stored lines', () => {
    const rows = [
      weekly(1, '08:00', '23:00'),
      weekly(2, '08:00', '23:00'),
      weekly(5, '22:00', '02:00'),
      weekly(6, '10:00', '18:45'),
      dated('2026-11-12', '14:00', '18:45'),
    ];
    const again = rowsOfWeek(weekRunsOf(rows), rows);
    expect(stored(again)).toEqual(stored(rows));
    expect(again.filter((r) => r.kind === 'dated')).toEqual([rows[4]]);
  });

  it('keeps a whole day whole, never folding it into a night', () => {
    const rows = [weekly(1, '00:00', '24:00'), weekly(2, '00:00', '24:00')];
    expect(stored(rowsOfWeek(weekRunsOf(rows), []))).toEqual(stored(rows));
    expect(wholeDaysInARow(rowsOfWeek(weekRunsOf(rows), []))).toHaveLength(1);
  });
});

describe('a line the editor refuses (start equal to end)', () => {
  const broken = weekly(2, '09:00', '09:00');

  it('is not drawn as a run, and a paint elsewhere keeps it as it is', () => {
    expect(weekRunsOf([broken])[1]).toEqual([]);
    const next = paintRows([broken], 0, 0, 16, 17, 'open');
    expect(next).toContainEqual(broken);
    expect(stored(next.filter((r) => r !== broken))).toEqual(['1 08:00-09:00']);
  });

  it('survives a template too, for the organiser to fix or remove', () => {
    expect(applyTemplate([broken], 'weekdays')).toContainEqual(broken);
  });
});

describe('painting a rectangle', () => {
  const base = [weekly(1, '08:00', '12:00')];

  it('opens what is closed and merges with what touches it', () => {
    // Monday, rows 24..27 = 12:00..14:00.
    const next = paintRows(base, 0, 0, 24, 27, 'open');
    expect(next).toEqual([weekly(1, '08:00', '14:00')]);
  });

  it('paints several days at once, in either direction', () => {
    const next = paintRows([], 2, 0, 18, 17, 'open');
    expect(stored(next)).toEqual(['1 08:30-09:30', '2 08:30-09:30', '3 08:30-09:30'].sort());
  });

  it('closes what is open and splits a run it cuts in the middle', () => {
    const next = paintRows(base, 0, 0, 18, 19, 'close');
    expect(stored(next)).toEqual(['1 08:00-09:00', '1 10:00-12:00'].sort());
  });

  it('takes its mode from where it starts: a closed cell opens, an open one closes', () => {
    const week = weekRunsOf(base);
    expect(isOpenAt(week, 0, 16)).toBe(true);
    expect(isOpenAt(week, 0, 24)).toBe(false);
    expect(modeFrom(week, 0, 16)).toBe('close');
    expect(modeFrom(week, 0, 24)).toBe('open');
  });

  it('returns the very same rows when a gesture changes nothing', () => {
    expect(paintRows(base, 0, 0, 16, 17, 'open')).toBe(base);
    expect(paintRows(base, 1, 1, 16, 17, 'close')).toBe(base);
  });

  it('never rounds an edge it does not cover: an 18:45 end survives a paint elsewhere', () => {
    const rows = [weekly(4, '14:00', '18:45')];
    const next = paintRows(rows, 4, 4, 20, 21, 'open');
    expect(stored(next)).toEqual(['4 14:00-18:45', '5 10:00-11:00'].sort().map((s) => s));
  });

  it('closing over an off-grain edge cuts at the grain and keeps the rest', () => {
    const rows = [weekly(4, '14:00', '18:45')];
    // Rows 36..37 = 18:00..19:00 close: the run keeps 14:00-18:00.
    expect(stored(paintRows(rows, 3, 3, 36, 37, 'close'))).toEqual(['4 14:00-18:00']);
  });

  it('paints to the end of the day as 24:00, and a night joins across the day line', () => {
    const next = paintRows([], 4, 4, 44, 47, 'open');
    expect(next).toEqual([weekly(5, '22:00', '24:00')]);
    const night = paintRows(next, 5, 5, 0, 3, 'open');
    expect(night).toEqual([weekly(5, '22:00', '02:00')]);
  });

  it('leaves dated lines alone', () => {
    const rows = [dated('2026-11-12', '14:00', '18:45')];
    expect(paintRows(rows, 0, 0, 0, 1, 'open')).toEqual([
      weekly(1, '00:00', '01:00'),
      dated('2026-11-12', '14:00', '18:45'),
    ]);
  });
});

describe('editing the exact edges of a run (the keyboard and the off-grain route)', () => {
  it('moves an edge off the grain and keeps it', () => {
    const rows = [weekly(1, '10:00', '12:00')];
    const next = editRun(rows, 0, [600, 720], 600, 735)!;
    expect(stored(next)).toEqual(['1 10:00-12:15']);
  });

  it('merges with the run it now touches, and refuses a non-range', () => {
    const rows = [weekly(1, '08:00', '10:00'), weekly(1, '11:00', '12:00')];
    expect(stored(editRun(rows, 0, [480, 600], 480, 660)!)).toEqual(['1 08:00-12:00']);
    expect(editRun(rows, 0, [480, 600], 600, 600)).toBeNull();
    expect(editRun(rows, 0, [480, 600], 700, 650)).toBeNull();
  });

  it('a slot keeps its neighbours separate, and is refused on an overlap', () => {
    const rows = [weekly(1, '14:00', '14:30'), weekly(1, '14:30', '15:00')];
    expect(stored(editSlot(rows, 0, [840, 870], 840, 860)!)).toEqual([
      '1 14:00-14:20',
      '1 14:30-15:00',
    ]);
    expect(editSlot(rows, 0, [840, 870], 840, 880)).toBeNull();
    expect(editSlot(rows, 0, [840, 870], 860, 860)).toBeNull();
  });

  it('a fixed-slot space picks hours on the step its slots need', () => {
    expect(slotStep([weekly(1, '14:00', '14:30')], 30)).toBe(30);
    expect(slotStep([weekly(1, '14:25', '14:50')], 25)).toBe(5);
    expect(slotStep([], null)).toBe(60);
  });
});

describe('the templates', () => {
  it('draws the four of D49', () => {
    expect(templateWeek('always').every((d) => d.length === 1 && d[0][1] - d[0][0] === 1440)).toBe(
      true
    );
    expect(stored(applyTemplate([], 'weekdays'))).toEqual(
      [1, 2, 3, 4, 5].map((d) => `${d} 08:00-20:00`)
    );
    expect(applyTemplate([weekly(1, '08:00', '09:00')], 'empty')).toEqual([]);
  });

  it('replaces the week and keeps the dated lines', () => {
    const rows = [weekly(1, '08:00', '09:00'), dated('2026-11-12', '14:00', '18:45')];
    expect(applyTemplate(rows, 'weekdays').filter((r) => r.kind === 'dated')).toEqual([rows[1]]);
    expect(applyTemplate(rows, 'empty')).toEqual([rows[1]]);
  });

  it('"always" is a 24/7 week, which the existing warning names; the others are not', () => {
    expect(wholeDaysInARow(applyTemplate([], 'always')).length).toBe(7);
    expect(wholeDaysInARow(applyTemplate([], 'weekdays'))).toEqual([]);
  });

  it('"event" empties the week and offers one dated line to fill, once', () => {
    const once = applyTemplate([weekly(1, '08:00', '09:00')], 'event');
    expect(once).toEqual([dated('', '14:00', '18:00')]);
    expect(applyTemplate(once, 'event')).toEqual(once);
  });
});

describe('the reading of a day', () => {
  it('says its runs, and nothing when closed', () => {
    expect(formatRuns([[480, 1380]])).toBe('08:00 - 23:00');
    expect(
      formatRuns([
        [0, 120],
        [1320, 1440],
      ])
    ).toBe('00:00 - 02:00, 22:00 - 24:00');
    expect(formatRuns([])).toBe('');
  });
});

describe('fixed slots (owner, 2026-10-29): whole slots, never merged', () => {
  const ALUMNI = [
    weekly(1, '14:00', '14:25'),
    weekly(1, '14:25', '14:50'),
    weekly(1, '14:50', '15:15'),
  ];

  it('reads each slot as its own run', () => {
    expect(weekSlotsOf(ALUMNI)[0]).toEqual([
      [840, 865],
      [865, 890],
      [890, 915],
    ]);
    // The step reading merges them: the very thing a fixed-slot space must not do.
    expect(weekRunsOf(ALUMNI)[0]).toEqual([[840, 915]]);
  });

  it('takes the most common slot length, the grain when there is none', () => {
    expect(slotLengthOf(ALUMNI)).toBe(25);
    expect(slotLengthOf([...ALUMNI, weekly(2, '10:00', '10:20')])).toBe(25);
    expect(slotLengthOf([])).toBe(30);
    expect(slotLengthOf([weekly(1, '10:00', '10:20'), weekly(1, '11:00', '11:25')])).toBe(20);
  });

  it('takes the STORED length first (migration 116), the lines only when none is stored', () => {
    expect(slotLengthFor(ALUMNI, 60)).toBe(60);
    expect(slotLengthFor([], 25)).toBe(25);
    // A space created before the length was stored: read from its lines, as before.
    expect(slotLengthFor(ALUMNI, null)).toBe(25);
    expect(slotLengthFor([], null)).toBe(30);
  });

  it('opens slots of the stored length on an EMPTIED week, where the lines say nothing', () => {
    // Mon 14:00-15:00 painted: three 25-min starts fall inside it.
    expect(stored(paintSlotRows([], 0, 0, 28, 29, 'open', 25).rows)).toEqual([
      '1 14:00-14:25',
      '1 14:25-14:50',
      '1 14:50-15:15',
    ]);
    // Unstored, the same paint falls back to the grain.
    expect(stored(paintSlotRows([], 0, 0, 28, 29, 'open', null).rows)).toEqual([
      '1 14:00-14:30',
      '1 14:30-15:00',
    ]);
  });

  it('opens slots of the stored length even where the lines say another', () => {
    expect(stored(paintSlotRows(ALUMNI, 1, 1, 28, 28, 'open', 60).rows).slice(3)).toEqual([
      '2 14:00-15:00',
    ]);
    // A legacy space (null) keeps inferring 25 from the same lines.
    expect(stored(paintSlotRows(ALUMNI, 1, 1, 28, 28, 'open', null).rows).slice(3)).toEqual([
      '2 14:00-14:25',
      '2 14:25-14:50',
    ]);
  });

  it('closes only the slots the rectangle touches, whole', () => {
    // Row 29 (14:30-15:00) touches the second slot and the third.
    expect(stored(paintSlotRows(ALUMNI, 0, 0, 29, 29, 'close').rows)).toEqual(['1 14:00-14:25']);
    // Row 28 (14:00-14:30) touches the first two.
    expect(stored(paintSlotRows(ALUMNI, 0, 0, 28, 28, 'close').rows)).toEqual(['1 14:50-15:15']);
  });

  it('opens whole slots of the length, skipping those that would overlap', () => {
    const next = paintSlotRows(ALUMNI, 0, 1, 28, 31, 'open').rows; // Mon..Tue 14:00-16:00
    expect(stored(next)).toEqual([
      '1 14:00-14:25',
      '1 14:25-14:50',
      '1 14:50-15:15',
      '1 15:15-15:40',
      '1 15:40-16:05',
      '2 14:00-14:25',
      '2 14:25-14:50',
      '2 14:50-15:15',
      '2 15:15-15:40',
      '2 15:40-16:05',
    ]);
    // Each is its own line: nothing was merged.
    expect(next.filter((r) => r.kind === 'weekly')).toHaveLength(10);
  });

  it('a tap opens one whole slot, even longer than the cell', () => {
    expect(stored(paintSlotRows([weekly(1, '09:00', '10:00')], 2, 2, 20, 20, 'open').rows)).toEqual(
      ['1 09:00-10:00', '3 10:00-11:00']
    );
  });

  it('returns the same rows when nothing changes, and leaves dated lines alone', () => {
    const rows = [...ALUMNI, dated('2026-11-03', '14:00', '15:00')];
    expect(paintSlotRows(rows, 3, 3, 28, 28, 'close').rows).toBe(rows);
    expect(paintSlotRows(rows, 0, 0, 28, 28, 'open').rows).toBe(rows);
    expect(
      paintSlotRows(rows, 0, 6, 0, 47, 'close').rows.filter((r) => r.kind === 'dated')
    ).toHaveLength(1);
  });

  it('an empty week opens slots of the 30-min grain: no slot length is stored anywhere', () => {
    // A fixed-slot space keeps its slot length only in its lines (the wizard cuts them, no field
    // holds it), so a week emptied of slots has none to read.
    expect(stored(paintSlotRows([], 0, 0, 20, 21, 'open').rows)).toEqual([
      '1 10:00-10:30',
      '1 10:30-11:00',
    ]);
  });

  it('a slot spanning midnight is ONE slot: drawn on both days, closed whole from either', () => {
    const night = [weekly(5, '23:30', '00:30')];
    const week = weekSlotsOf(night);
    expect(week[4]).toEqual([[1410, 1440]]);
    expect(week[5]).toEqual([[0, 30]]);
    expect(slotLengthOf(night)).toBe(60);
    // Saturday 00:00 closes the whole night slot, Friday's half included.
    expect(paintSlotRows(night, 5, 5, 0, 0, 'close').rows).toEqual([]);
    // An hour opened over Friday 23:00 would overlap its evening half: nothing opens.
    expect(paintSlotRows(night, 4, 4, 46, 47, 'open').rows).toBe(night);
  });

  it('stops an open at the line cap and counts what it could not open', () => {
    // 199 slots of 25 min already: one more fits, the rest of the drag is refused.
    const full: EditorLine[] = [];
    for (let i = 0; full.length < MAX_AVAILABILITY_LINES - 1; i++) {
      const day = Math.floor(i / 50);
      const start = (i % 50) * 25;
      full.push(weekly(day + 1, timeOf(start), timeOf(start + 25)));
    }
    const painted = paintSlotRows(full, 6, 6, 0, 47, 'open'); // Sunday, the whole day
    expect(toStoredLines(painted.rows)).toHaveLength(MAX_AVAILABILITY_LINES);
    expect(painted.refused).toBe(Math.floor(1440 / 25) - 1);
    // At the cap, an open adds nothing and the rows are the same.
    const again = paintSlotRows(painted.rows, 6, 6, 0, 47, 'open');
    expect(again.rows).toBe(painted.rows);
    expect(again.refused).toBeGreaterThan(0);
  });

  it('round-trips the saved lines: read, painted, saved, read again', () => {
    const saved = [
      { weekday: 1, onDate: null, startTime: '14:00:00', endTime: '14:25:00' },
      { weekday: 1, onDate: null, startTime: '14:25:00', endTime: '14:50:00' },
      { weekday: 5, onDate: null, startTime: '23:30:00', endTime: '24:00:00' },
      { weekday: 6, onDate: null, startTime: '00:00:00', endTime: '00:30:00' },
    ];
    const rows = fromStoredLines(saved);
    // Nothing painted: the very lines the server holds go back.
    expect(toStoredLines(rows)).toEqual(
      saved.map((l) => ({
        ...l,
        startTime: l.startTime.slice(0, 5),
        endTime: l.endTime.slice(0, 5),
      }))
    );
    // A paint adds its slot and keeps every saved line as it was, none merged.
    const after = toStoredLines(paintSlotRows(rows, 1, 1, 28, 28, 'open').rows);
    expect(after).toHaveLength(saved.length + 2);
    expect(after.slice(0, 4).map((l) => `${l.weekday} ${l.startTime}-${l.endTime}`)).toEqual([
      '1 14:00-14:25',
      '1 14:25-14:50',
      '5 23:30-24:00',
      '6 00:00-00:30',
    ]);
  });
});

describe('templatePreview', () => {
  it('draws exactly what the template opens', () => {
    expect(templatePreview('always')).toHaveLength(7);
    expect(templatePreview('always').every((b) => b.from === 0 && b.to === 1)).toBe(true);
    const weekdays = templatePreview('weekdays');
    expect(weekdays.map((b) => b.day)).toEqual([0, 1, 2, 3, 4]);
    expect(weekdays[0].from).toBeCloseTo(8 / 24);
    expect(weekdays[0].to).toBeCloseTo(20 / 24);
  });

  it('shows a window on two days for an event, and nothing for the empty week', () => {
    expect(templatePreview('event').map((b) => b.day)).toEqual([3, 4]);
    expect(templatePreview('empty')).toEqual([]);
  });
});

function timeOf(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
