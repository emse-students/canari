// @vitest-environment happy-dom
/**
 * THE PAINTED WEEK WRITES THE SAME LINES THE LIST DOES (WP-R4, D49). Pinned: a template and a drag
 * both change the one set of lines the save sends; a gesture starting on an open cell closes; a
 * night painted on two days is saved as the two stored halves; a press paints one cell; and the dated lines have their own list.
 * On a FIXED-SLOT space (owner, 2026-10-29) a paint opens or closes whole slots and never merges
 * them, while a step space still merges touching hours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const setAvailability = vi.hoisted(() => vi.fn());
vi.mock('$lib/bookings/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/bookings/api')>()),
  setAvailability: (...a: unknown[]) => setAvailability(...a),
}));

import AvailabilityEditor from './AvailabilityEditor.svelte';

const mounted: (() => void)[] = [];
const onDirty = vi.fn();

async function open(lines: unknown[] = [], fixedSlots = false, slotMinutes: number | null = null) {
  const app = mount(AvailabilityEditor, {
    target: document.body,
    props: {
      spaceId: 's',
      timeZone: 'Europe/Paris',
      resourceId: 'r',
      resourceName: 'Salle',
      lines: lines as never,
      exceptions: [],
      stepMinutes: fixedSlots ? null : 30,
      fixedSlots,
      slotMinutes,
      onSaved: vi.fn(),
      onDirty,
    },
  });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  await tick();
}

/** A pointer event; the painter maps x to a day (100 px a day) and y to a row (10 px a row). */
function pointer(type: string, x: number, y: number) {
  const target = document.querySelector('[data-painter]')!;
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
  target.dispatchEvent(event);
  flushSync();
}

/** Paints from (day0, slot0) to (day1, slot1), both ends included. */
function drag(day0: number, slot0: number, day1: number, slot1: number) {
  pointer('pointerdown', day0 * 100 + 50, slot0 * 10 + 5);
  pointer('pointermove', day1 * 100 + 50, slot1 * 10 + 5);
  pointer('pointerup', day1 * 100 + 50, slot1 * 10 + 5);
}

async function saved() {
  const save = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Enregistrer les disponibilit')
  )!;
  save.click();
  flushSync();
  await tick();
  return setAvailability.mock.calls.at(-1)?.[1] as {
    weekday: number | null;
    startTime: string;
    endTime: string;
    onDate: string | null;
  }[];
}

const times = (lines: { weekday: number | null; startTime: string; endTime: string }[]) =>
  lines.map((l) => `${l.weekday} ${l.startTime}-${l.endTime}`).sort();

beforeEach(() => {
  setAvailability.mockReset();
  setAvailability.mockResolvedValue(undefined);
  onDirty.mockReset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  Element.prototype.setPointerCapture = vi.fn();
  // jsdom has no layout: the painter's box is 700 x 480 px, seven days by forty-eight rows.
  Element.prototype.getBoundingClientRect = function () {
    return {
      left: 0,
      top: 0,
      width: 700,
      height: 480,
      right: 700,
      bottom: 480,
      x: 0,
      y: 0,
    } as DOMRect;
  };
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('AvailabilityEditor - the painted week', () => {
  it('a template fills the week, and the save sends those lines', async () => {
    await open();
    document.querySelector<HTMLElement>('[data-template="weekdays"]')!.click();
    flushSync();
    expect(times(await saved())).toEqual([1, 2, 3, 4, 5].map((d) => `${d} 08:00-20:00`));
  });

  it('a drag over closed cells opens the rectangle on every day it crosses', async () => {
    await open();
    drag(0, 16, 2, 19); // Mon..Wed, rows 16..19 = 08:00..10:00
    expect(times(await saved())).toEqual(['1 08:00-10:00', '2 08:00-10:00', '3 08:00-10:00']);
  });

  it('a gesture that starts on an open cell closes, splitting a run', async () => {
    await open([{ weekday: 1, onDate: null, startTime: '08:00:00', endTime: '12:00:00' }]);
    drag(0, 18, 0, 19); // rows 18..19 = 09:00..10:00, pressed on an open cell
    expect(times(await saved())).toEqual(['1 08:00-09:00', '1 10:00-12:00']);
  });

  it('paints a night on two days and saves its two stored halves', async () => {
    await open();
    drag(4, 44, 4, 47); // Friday 22:00 to the end of the day
    drag(5, 0, 5, 3); // Saturday 00:00 to 02:00
    const lines = await saved();
    expect(times(lines)).toEqual(['5 22:00-24:00', '6 00:00-02:00']);
  });

  it('a press without a move paints its one cell, and marks the editor dirty', async () => {
    await open();
    onDirty.mockClear();
    drag(3, 20, 3, 20);
    expect(onDirty).toHaveBeenCalledWith(true);
    expect(times(await saved())).toEqual(['4 10:00-10:30']);
  });

  it('keeps the dated lines in their own list, untouched by a template', async () => {
    await open([
      { weekday: null, onDate: '2026-11-12', startTime: '14:00:00', endTime: '18:45:00' },
    ]);
    document.querySelector<HTMLElement>('[data-template="always"]')!.click();
    flushSync();
    const lines = await saved();
    expect(lines.filter((l) => l.onDate)).toEqual([
      expect.objectContaining({ onDate: '2026-11-12', startTime: '14:00', endTime: '18:45' }),
    ]);
    expect(lines.filter((l) => l.weekday)).toHaveLength(7);
  });
});

describe('AvailabilityEditor - the exact hours of a run, and a refused line made visible', () => {
  it('lists a refused weekly line, removable, instead of an invisible blocker', async () => {
    await open([
      { weekday: 2, onDate: null, startTime: '10:00:00', endTime: '10:00:00' },
      { weekday: 1, onDate: null, startTime: '08:00:00', endTime: '12:00:00' },
    ]);
    const list = document.querySelector('[data-invalid-weekly]')!;
    expect(list.textContent).toContain('10:00-10:00');
    const save = () =>
      [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Enregistrer les disponibilit')
      )!;
    expect(save().disabled).toBe(true);
    list.querySelector<HTMLElement>('button[aria-label]')!.click();
    flushSync();
    expect(document.querySelector('[data-invalid-weekly]')).toBeNull();
    expect(save().disabled).toBe(false);
    expect(times(await saved())).toEqual(['1 08:00-12:00']);
  });

  it('a run has a focusable button named by its day and hours, which opens its editor', async () => {
    await open([{ weekday: 1, onDate: null, startTime: '10:00:00', endTime: '12:00:00' }]);
    const button = document.querySelector<HTMLButtonElement>('[data-run-edit]')!;
    expect(button.getAttribute('aria-label')).toMatch(/Lundi 10:00-12:00/);
    expect(document.querySelector('[data-run-editor]')).toBeNull();
    button.click();
    flushSync();
    expect(document.querySelector('[data-run-editor]')).not.toBeNull();
    // The press never reached the grid's gesture: the run is still open.
    expect(times(await saved())).toEqual(['1 10:00-12:00']);
  });
});

describe('AvailabilityEditor - a fixed-slot space (owner, 2026-10-29)', () => {
  const slot = (weekday: number, start: string, end: string) => ({
    weekday,
    onDate: null,
    startTime: `${start}:00`,
    endTime: `${end}:00`,
  });
  // Three touching 30-min slots: one painter row each.
  const SLOTS = [slot(1, '14:00', '14:30'), slot(1, '14:30', '15:00'), slot(1, '15:00', '15:30')];

  it('a press on one slot closes that slot alone, whole', async () => {
    await open(SLOTS, true);
    drag(0, 29, 0, 29); // row 29 = 14:30, the second slot
    expect(times(await saved())).toEqual(['1 14:00-14:30', '1 15:00-15:30']);
  });

  it('a paint elsewhere leaves touching slots separate', async () => {
    await open(SLOTS, true);
    drag(1, 28, 1, 28); // Tuesday 14:00: opens ONE slot of the week's length
    expect(times(await saved())).toEqual([
      '1 14:00-14:30',
      '1 14:30-15:00',
      '1 15:00-15:30',
      '2 14:00-14:30',
    ]);
    // The painter still draws Monday as three slots, not one run.
    const monday = document
      .querySelector('[data-painter] [data-day="0"]')!
      .getAttribute('aria-label');
    expect(monday).toContain('14:00 - 14:30, 14:30 - 15:00, 15:00 - 15:30');
  });

  it('a step space still merges touching hours, as before', async () => {
    await open([slot(1, '14:00', '14:25'), slot(1, '14:25', '14:50')]);
    drag(1, 28, 1, 28);
    expect(times(await saved())).toEqual(['1 14:00-14:50', '2 14:00-14:30']);
  });

  it('says so under the painter when the cap stops a paint, instead of a refused save', async () => {
    const at = (min: number) =>
      `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    // 199 one-slot lines: Monday..Thursday, 50 slots of 25 min each, minus one.
    const lines = [];
    for (let i = 0; lines.length < 199; i++) {
      const start = (i % 50) * 25;
      lines.push(slot(Math.floor(i / 50) + 1, at(start), at(start + 25)));
    }
    await open(lines, true);
    drag(6, 0, 6, 47); // the whole Sunday
    expect(document.body.textContent).toContain('au-delà des 200');
    expect((await saved()).length).toBe(200);
  });

  it('on an EMPTIED week, a press opens a slot of the STORED length (migration 116)', async () => {
    await open([], true, 45);
    expect(document.body.textContent).toContain('créneau de 45 min');
    drag(0, 28, 0, 28); // Monday 14:00
    expect(times(await saved())).toEqual(['1 14:00-14:45']);
  });

  it('a space with no stored length still reads it from its lines', async () => {
    await open(SLOTS, true, null);
    drag(1, 28, 1, 28);
    expect(times(await saved())).toContain('2 14:00-14:30');
  });
});
