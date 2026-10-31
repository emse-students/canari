import {
  type AvailabilityException,
  type AvailabilityLine,
  type SlotConfig,
  availabilityWindows,
  bookingsOutsideAvailability,
  checkRangeShape,
  datesAround,
  rangeLengthRefusal,
  slotUnits,
  unitStates,
} from './slots';
import { addDays } from './zoned-time';

const PARIS = 'Europe/Paris';
const step = (stepMinutes = 30, maxSteps = 4): SlotConfig => ({
  timeZone: PARIS,
  slotMode: 'step',
  stepMinutes,
  maxSteps,
});
const SLOTS: SlotConfig = { timeZone: PARIS, slotMode: 'slots', stepMinutes: null, maxSteps: null };

const weekly = (weekday: number, startTime: string, endTime: string): AvailabilityLine => ({
  weekday,
  onDate: null,
  startTime,
  endTime,
});
const dated = (onDate: string, startTime: string, endTime: string): AvailabilityLine => ({
  weekday: null,
  onDate,
  startTime,
  endTime,
});
const ms = (isoText: string) => Date.parse(isoText);
const show = (w: { date: string; startMs: number; endMs: number }) =>
  `${w.date} ${new Date(w.startMs).toISOString().slice(11, 16)}-${new Date(w.endMs).toISOString().slice(11, 16)}Z`;

describe('availabilityWindows: the windows and slots of one resource (D3, D11, D25)', () => {
  it.each<
    [string, SlotConfig, AvailabilityLine[], AvailabilityException[], string, string, string[]]
  >([
    [
      'a recurrent 18:00 stays 18:00 local across the fall-back change (16:00Z then 17:00Z)',
      step(),
      [weekly(1, '18:00', '20:00')],
      [],
      '2026-10-19',
      '2026-10-26',
      ['2026-10-19 16:00-18:00Z', '2026-10-26 17:00-19:00Z'],
    ],
    [
      'and across the spring-forward change',
      step(),
      [weekly(1, '18:00', '20:00')],
      [],
      '2026-03-23',
      '2026-03-30',
      ['2026-03-23 17:00-19:00Z', '2026-03-30 16:00-18:00Z'],
    ],
    [
      'a window crossing midnight is two lines, joined back into one window dated by its start',
      step(),
      [weekly(5, '22:00', '24:00'), weekly(6, '00:00', '02:00')],
      [],
      '2026-10-16',
      '2026-10-16',
      ['2026-10-16 20:00-00:00Z'],
    ],
    [
      'its after-midnight tail is not a window of the next day',
      step(),
      [weekly(5, '22:00', '24:00'), weekly(6, '00:00', '02:00')],
      [],
      '2026-10-17',
      '2026-10-17',
      [],
    ],
    [
      'overlapping lines are united in a step space',
      step(),
      [weekly(1, '10:00', '12:00'), dated('2026-10-19', '11:00', '13:00')],
      [],
      '2026-10-19',
      '2026-10-19',
      ['2026-10-19 08:00-11:00Z'],
    ],
    [
      'an exception removes whole local days, both ends included',
      step(),
      [weekly(1, '18:00', '20:00'), weekly(2, '18:00', '20:00'), weekly(3, '18:00', '20:00')],
      [{ fromDate: '2026-10-19', toDate: '2026-10-20' }],
      '2026-10-19',
      '2026-10-21',
      ['2026-10-21 16:00-18:00Z'],
    ],
    [
      'a dated line applies to its date only',
      step(),
      [dated('2026-11-04', '14:00', '18:45')],
      [],
      '2026-11-03',
      '2026-11-05',
      ['2026-11-04 13:00-17:45Z'],
    ],
    [
      'back-to-back predefined slots stay two slots',
      SLOTS,
      [dated('2026-11-04', '14:00', '14:25'), dated('2026-11-04', '14:25', '14:50')],
      [],
      '2026-11-04',
      '2026-11-04',
      ['2026-11-04 13:00-13:25Z', '2026-11-04 13:25-13:50Z'],
    ],
    [
      'a predefined slot across midnight is joined',
      SLOTS,
      [dated('2026-11-04', '23:45', '24:00'), dated('2026-11-05', '00:00', '00:10')],
      [],
      '2026-11-04',
      '2026-11-05',
      ['2026-11-04 22:45-23:10Z'],
    ],
    [
      'the same slot from a weekly and a dated line is one slot',
      SLOTS,
      [weekly(3, '14:00', '14:25'), dated('2026-11-04', '14:00', '14:25')],
      [],
      '2026-11-04',
      '2026-11-04',
      ['2026-11-04 13:00-13:25Z'],
    ],
  ])('%s', (_case, config, lines, exceptions, from, to, expected) => {
    expect(availabilityWindows(config, lines, exceptions, from, to).map(show)).toEqual(expected);
  });
});

describe('slotUnits: steps of ELAPSED time on a change night', () => {
  it.each([
    // 01:00-04:00 local on the fall-back night lasts FOUR hours: 8 steps of 30 min.
    ['fall back', '2026-10-25', 8],
    // ... and on the spring-forward night TWO hours: 4 steps.
    ['spring forward', '2026-03-29', 4],
    ['an ordinary night', '2026-10-18', 6],
  ])('%s', (_case, date, count) => {
    const windows = availabilityWindows(step(), [dated(date, '01:00', '04:00')], [], date, date);
    expect(slotUnits(step(), windows)).toHaveLength(count);
  });

  it('drops a trailing piece shorter than a step', () => {
    const windows = availabilityWindows(
      step(25),
      [dated('2026-11-04', '14:00', '15:00')],
      [],
      '2026-11-04',
      '2026-11-04'
    );
    expect(slotUnits(step(25), windows).map(show)).toEqual([
      '2026-11-04 13:00-13:25Z',
      '2026-11-04 13:25-13:50Z',
    ]);
  });
});

describe('checkRangeShape: one slot, or 1..maxSteps steps of one window', () => {
  const windows = availabilityWindows(
    step(30, 2),
    [dated('2026-11-04', '10:00', '12:00')],
    [],
    '2026-11-04',
    '2026-11-04'
  );
  it.each([
    ['one step', '09:00', '09:30', null],
    ['two steps', '09:30', '10:30', null],
    ['three steps over a ceiling of two', '09:00', '10:30', 'too-many-steps'],
    ['off the grid', '09:10', '09:40', 'misaligned'],
    ['not a whole number of steps', '09:00', '09:45', 'misaligned'],
    ['past the window', '10:30', '11:30', 'outside-availability'],
    ['reversed', '10:00', '09:00', 'misaligned'],
  ])('%s', (_case, from, to, refusal) => {
    expect(
      checkRangeShape(step(30, 2), windows, {
        startMs: ms(`2026-11-04T${from}:00Z`),
        endMs: ms(`2026-11-04T${to}:00Z`),
      })
    ).toBe(refusal);
  });

  it('takes a predefined slot exactly, and nothing else', () => {
    const slots = availabilityWindows(
      SLOTS,
      [dated('2026-11-04', '14:00', '14:25')],
      [],
      '2026-11-04',
      '2026-11-04'
    );
    const exact = { startMs: ms('2026-11-04T13:00:00Z'), endMs: ms('2026-11-04T13:25:00Z') };
    expect(checkRangeShape(SLOTS, slots, exact)).toBeNull();
    expect(checkRangeShape(SLOTS, slots, { ...exact, endMs: exact.endMs - 60_000 })).toBe(
      'outside-availability'
    );
  });
});

describe('unitStates', () => {
  const units = [
    { startMs: 0, endMs: 10 },
    { startMs: 10, endMs: 20 },
    { startMs: 20, endMs: 30 },
  ];
  it('says blocked over booked over free, on half-open ranges', () => {
    expect(
      unitStates(units, [{ id: 'b', startMs: 5, endMs: 20 }], [{ id: 'k', startMs: 10, endMs: 20 }])
    ).toEqual([
      { state: 'booked', bookingId: 'b' },
      { state: 'blocked', blockId: 'k' },
      { state: 'free' },
    ]);
  });
});

describe('bookingsOutsideAvailability: the D29 refusal', () => {
  const lines = [weekly(1, '18:00', '20:00')];
  // Monday 2026-10-26 18:00-19:00 local (CET) = 17:00-18:00Z.
  const booking = {
    id: 'b1',
    startMs: ms('2026-10-26T17:00:00Z'),
    endMs: ms('2026-10-26T18:00:00Z'),
  };

  it.each<[string, SlotConfig, AvailabilityLine[], AvailabilityException[], string[]]>([
    ['the same availability keeps it', step(), lines, [], []],
    ['a widened availability keeps it', step(), [weekly(1, '17:00', '21:00')], [], []],
    ['a shortened window names it', step(), [weekly(1, '18:30', '20:00')], [], ['b1']],
    [
      'an exception over its day names it',
      step(),
      lines,
      [{ fromDate: '2026-10-26', toDate: '2026-10-26' }],
      ['b1'],
    ],
    ['a step it no longer fits names it', step(45, 4), lines, [], ['b1']],
    ['a lower ceiling of steps names it', step(30, 1), lines, [], ['b1']],
    ['predefined slots that do not match name it', SLOTS, lines, [], ['b1']],
  ])('%s', (_case, config, newLines, exceptions, named) => {
    expect(
      bookingsOutsideAvailability(config, newLines, exceptions, [booking]).map((b) => b.id)
    ).toEqual(named);
  });

  it('keeps a booking inside a window that crosses midnight', () => {
    const night = {
      id: 'n',
      startMs: ms('2026-10-16T21:30:00Z'),
      endMs: ms('2026-10-16T22:30:00Z'),
    };
    const crossing = [weekly(5, '22:00', '24:00'), weekly(6, '00:00', '02:00')];
    // 23:30-00:30 local: the joined window holds it, neither half alone would.
    expect(bookingsOutsideAvailability(step(), crossing, [], [night])).toEqual([]);
  });
});

describe('a window crosses AT MOST ONE midnight (review of #1993)', () => {
  const allWeek = [1, 2, 3, 4, 5, 6, 7].map((d) => weekly(d, '00:00:00', '24:00:00'));
  // Monday 20:00 to Wednesday 02:00, written as three lines.
  const chain = [
    weekly(1, '20:00:00', '24:00:00'),
    weekly(2, '00:00:00', '24:00:00'),
    weekly(3, '00:00:00', '02:00:00'),
  ];

  it('a 24/7 resource is one window per day, never one chained window', () => {
    expect(
      availabilityWindows(step(60, 2), allWeek, [], '2026-11-02', '2026-11-03').map(show)
    ).toEqual(['2026-11-02 23:00-23:00Z', '2026-11-03 23:00-23:00Z']);
  });

  // Two whole days in a row are ONE continuous opening: a booking runs from one day's window into
  // the next one's (docs/wiki/bookings-chantier.md, "a booking crosses the midnight between two
  // open days"). Paris is UTC+1 in November.
  const shapeOf = (
    config: SlotConfig,
    lines: AvailabilityLine[],
    exceptions: AvailabilityException[],
    startIso: string,
    endIso: string
  ) => {
    const range = { startMs: ms(startIso), endMs: ms(endIso) };
    const [from, to] = datesAround(range, PARIS);
    return checkRangeShape(config, availabilityWindows(config, lines, exceptions, from, to), range);
  };

  it.each<
    [string, SlotConfig, AvailabilityLine[], AvailabilityException[], string, string, string | null]
  >([
    [
      'a 24/7 resource accepts 22:00-02:00 across midnight, Monday to Tuesday',
      step(60, 4),
      allWeek,
      [],
      '2026-11-02T21:00:00Z',
      '2026-11-03T01:00:00Z',
      null,
    ],
    [
      'the week wraps: Sunday 23:00 to Monday 01:00',
      step(60, 2),
      allWeek,
      [],
      '2026-11-08T22:00:00Z',
      '2026-11-09T00:00:00Z',
      null,
    ],
    [
      'a whole weekly day into a whole dated day',
      step(60, 2),
      [weekly(1, '00:00', '24:00'), dated('2026-11-03', '00:00', '24:00')],
      [],
      '2026-11-02T22:00:00Z',
      '2026-11-03T00:00:00Z',
      null,
    ],
    [
      'a several-day booking when maxSteps allows it (Monday 10:00 to Wednesday 10:00)',
      step(60, 48),
      allWeek,
      [],
      '2026-11-02T09:00:00Z',
      '2026-11-04T09:00:00Z',
      null,
    ],
    [
      'maxSteps still holds across midnight',
      step(60, 2),
      allWeek,
      [],
      '2026-11-02T21:00:00Z',
      '2026-11-03T01:00:00Z',
      'too-many-steps',
    ],
    [
      'a booking into a closed day is refused',
      step(60, 4),
      [weekly(1, '00:00', '24:00')],
      [],
      '2026-11-02T22:00:00Z',
      '2026-11-03T00:00:00Z',
      'outside-availability',
    ],
    [
      'a closure (exception) cuts the opening at midnight',
      step(60, 4),
      allWeek,
      [{ fromDate: '2026-11-03', toDate: '2026-11-03' }],
      '2026-11-02T22:00:00Z',
      '2026-11-03T00:00:00Z',
      'outside-availability',
    ],
    [
      'a gap between two days cuts it (Monday ends 23:00)',
      step(60, 4),
      [weekly(1, '00:00', '23:00'), weekly(2, '00:00', '24:00')],
      [],
      '2026-11-02T21:00:00Z',
      '2026-11-03T00:00:00Z',
      'outside-availability',
    ],
    [
      'a step the day does not end on cannot carry a booking past midnight',
      step(25, 10),
      allWeek,
      [],
      // Monday's last 25-min step is 23:20-23:45 local; the next starts at Tuesday 00:00.
      '2026-11-02T22:20:00Z',
      '2026-11-02T23:10:00Z',
      'misaligned',
    ],
    [
      'whole-day predefined slots are still booked whole, never across',
      SLOTS,
      allWeek,
      [],
      '2026-11-02T22:00:00Z',
      '2026-11-03T00:00:00Z',
      'outside-availability',
    ],
  ])('%s', (_case, config, lines, exceptions, start, end, refusal) => {
    expect(shapeOf(config, lines, exceptions, start, end)).toBe(refusal);
  });

  describe('an over-long range is refused before any window is built', () => {
    // Forty years on a 24/7 resource in 5-min steps: the bound answers from the settings alone.
    const decades = { startMs: ms('2026-11-02T22:00:00Z'), endMs: ms('2066-11-02T22:00:00Z') };

    it.each<[string, SlotConfig, string]>([
      ['a step space: longer than maxSteps x step', step(5, 12), 'too-many-steps'],
      ['a slots space: longer than any slot can last', SLOTS, 'outside-availability'],
    ])('%s', (_case, config, refusal) => {
      expect(rangeLengthRefusal(config, decades)).toBe(refusal);
      const started = Date.now();
      // No window is passed: the bound must not need one.
      expect(checkRangeShape(config, [], decades)).toBe(refusal);
      expect(
        bookingsOutsideAvailability(config, allWeek, [], [{ id: 'x', ...decades }])
      ).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('keeps a range exactly maxSteps long, and an empty one is misaligned', () => {
      const twoHours = { startMs: ms('2026-11-02T22:00:00Z'), endMs: ms('2026-11-03T00:00:00Z') };
      expect(rangeLengthRefusal(step(60, 2), twoHours)).toBeNull();
      expect(rangeLengthRefusal(step(60, 2), { startMs: 1, endMs: 1 })).toBe('misaligned');
    });
  });

  it('D29 keeps a booking across midnight while both days stay open, and names it when one closes', () => {
    const night = {
      id: 'n',
      startMs: ms('2026-11-02T22:00:00Z'),
      endMs: ms('2026-11-03T00:00:00Z'),
    };
    expect(bookingsOutsideAvailability(step(60, 2), allWeek, [], [night])).toEqual([]);
    expect(
      bookingsOutsideAvailability(
        step(60, 2),
        allWeek,
        [{ fromDate: '2026-11-03', toDate: '2026-11-03' }],
        [night]
      ).map((b) => b.id)
    ).toEqual(['n']);
  });

  it('a 24/7 resource keeps an ordinary booking under an unchanged availability (D29)', () => {
    const b = { id: 'b', startMs: ms('2026-11-10T09:00:00Z'), endMs: ms('2026-11-10T10:00:00Z') };
    expect(bookingsOutsideAvailability(step(60, 2), allWeek, [], [b])).toEqual([]);
  });

  it('Monday 20:00 to Wednesday 02:00: Tuesday shows its own day and the Wednesday tail', () => {
    expect(
      availabilityWindows(step(60, 2), chain, [], '2026-11-03', '2026-11-03').map(show)
    ).toEqual(['2026-11-03 23:00-01:00Z']);
    expect(
      availabilityWindows(step(60, 2), chain, [], '2026-11-02', '2026-11-02').map(show)
    ).toEqual(['2026-11-02 19:00-23:00Z']);
    expect(availabilityWindows(step(60, 2), chain, [], '2026-11-04', '2026-11-04')).toEqual([]);
  });

  it('the grid and the D29 check agree on Tuesday 13:00', () => {
    const tue = { id: 't', startMs: ms('2026-11-03T12:00:00Z'), endMs: ms('2026-11-03T13:00:00Z') };
    const units = slotUnits(
      step(60, 2),
      availabilityWindows(step(60, 2), chain, [], '2026-11-03', '2026-11-03')
    );
    expect(units.some((u) => u.startMs === tue.startMs)).toBe(true);
    expect(bookingsOutsideAvailability(step(60, 2), chain, [], [tue])).toEqual([]);
  });

  it('whole-day predefined slots stay one slot per day', () => {
    expect(availabilityWindows(SLOTS, allWeek, [], '2026-11-03', '2026-11-03').map(show)).toEqual([
      '2026-11-03 23:00-23:00Z',
    ]);
  });

  it('a midnight slot joined once, its tail given by two lines counted once', () => {
    const lines = [
      weekly(1, '23:00:00', '24:00:00'),
      weekly(2, '00:00:00', '01:00:00'),
      dated('2026-11-03', '00:00:00', '01:00:00'),
    ];
    expect(availabilityWindows(SLOTS, lines, [], '2026-11-02', '2026-11-03').map(show)).toEqual([
      '2026-11-02 22:00-00:00Z',
    ]);
  });

  // THE ORACLE'S INVARIANT: whatever the availability, one day asked alone gives exactly that day's
  // part of a range asked at once - the grid never depends on how wide the request was.
  const AVAILABILITIES: [string, AvailabilityLine[], AvailabilityException[]][] = [
    ['24/7', allWeek, []],
    ['the Monday-Wednesday chain', chain, []],
    [
      '22:00-24:00 then 00:00-02:00',
      [weekly(5, '22:00', '24:00'), weekly(6, '00:00', '02:00')],
      [],
    ],
    [
      'a 24/7 week cut by an exception',
      allWeek,
      [{ fromDate: '2026-10-28', toDate: '2026-10-29' }],
    ],
    ['change-night lines', [weekly(7, '01:00', '04:00'), weekly(6, '22:00', '24:00')], []],
    [
      'overlapping and back-to-back lines',
      [weekly(2, '10:00', '12:00'), weekly(2, '11:00', '13:00'), weekly(2, '13:00', '14:00')],
      [],
    ],
  ];
  const FROM = '2026-10-20';
  const TO = '2026-11-05';
  for (const [name, lines, exceptions] of AVAILABILITIES) {
    for (const config of [step(30, 4), SLOTS]) {
      it(`${name} (${config.slotMode}): one day at a time = the range at once`, () => {
        const whole = availabilityWindows(config, lines, exceptions, FROM, TO);
        const byDay: string[] = [];
        for (let d = FROM; d <= TO; d = addDays(d, 1)) {
          byDay.push(...availabilityWindows(config, lines, exceptions, d, d).map(show));
        }
        expect(byDay).toEqual(whole.map(show));
        // No window crosses more than one local midnight: it is shorter than two days.
        for (const w of whole) expect(w.endMs - w.startMs).toBeLessThanOrEqual(48 * 3_600_000);
      });
    }
  }
});
