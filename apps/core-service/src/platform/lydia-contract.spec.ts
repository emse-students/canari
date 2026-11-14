/**
 * The Lydia contract terms' pure functions: the parse that refuses rather than corrects, the contract
 * year a date falls in (its boundary included), and the band a volume falls in. Every number here is
 * made up for the test and bears no relation to any real contract.
 */
import {
  LydiaContractInvalid,
  bandOf,
  contractYearOf,
  parisDate,
  parseAnniversary,
  parseLydiaContractTerms,
} from './lydia-contract';

describe('parseLydiaContractTerms', () => {
  it('reads nothing entered as every value unset', () => {
    expect(parseLydiaContractTerms(null)).toEqual({
      fluxTargetCents: null,
      vatBps: null,
      fees: {},
      bands: [],
    });
  });

  it('keeps a complete set as sent', () => {
    const terms = {
      fluxTargetCents: 123_456,
      vatBps: 1_111,
      fees: { remote: { percentBps: 77, fixedCents: 3 }, qr: { percentBps: 55, fixedCents: 0 } },
      bands: [
        { fromCents: 0, fees: { remote: { percentBps: 99, fixedCents: 4 } } },
        { fromCents: 50_000, fees: { remote: { percentBps: 88, fixedCents: 4 } } },
      ],
    };
    expect(parseLydiaContractTerms(terms)).toEqual(terms);
  });

  it.each([
    [{ vatBps: 1.5 }, 'vatBps'],
    [{ vatBps: 10_001 }, 'vatBps'],
    [{ fluxTargetCents: -1 }, 'fluxTargetCents'],
    [{ fluxTargetCents: '100' }, 'fluxTargetCents'],
    [{ fees: { cheque: { percentBps: 1, fixedCents: 1 } } }, 'fees.cheque'],
    [{ fees: { remote: { percentBps: 1 } } }, 'fees.remote.fixedCents'],
    [{ bands: { fromCents: 0 } }, 'bands'],
    [
      {
        bands: [
          { fromCents: 10, fees: {} },
          { fromCents: 10, fees: {} },
        ],
      },
      'bands[1].fromCents',
    ],
  ])('refuses %j naming %s', (raw, field) => {
    let caught: unknown;
    try {
      parseLydiaContractTerms(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LydiaContractInvalid);
    expect((caught as LydiaContractInvalid).field).toBe(field);
  });
});

describe('parseAnniversary', () => {
  it('accepts a real date and unsets on null or empty', () => {
    expect(parseAnniversary('2031-03-05')).toBe('2031-03-05');
    expect(parseAnniversary(null)).toBeNull();
    expect(parseAnniversary('')).toBeNull();
  });

  it('refuses a date that does not exist', () => {
    expect(() => parseAnniversary('2031-02-30')).toThrow(LydiaContractInvalid);
    expect(() => parseAnniversary('5 March')).toThrow(LydiaContractInvalid);
  });
});

describe('contractYearOf', () => {
  it('is null before the first anniversary', () => {
    expect(contractYearOf('2031-03-05', '2031-03-04')).toBeNull();
  });

  it('starts ON the anniversary and ends at the next one, exclusive', () => {
    expect(contractYearOf('2031-03-05', '2031-03-05')).toEqual({
      start: '2031-03-05',
      end: '2032-03-05',
      daysTotal: 366,
      daysLeft: 366,
    });
  });

  it('the day before an anniversary is the last day of the year before', () => {
    expect(contractYearOf('2031-03-05', '2033-03-04')).toMatchObject({
      start: '2032-03-05',
      end: '2033-03-05',
      daysLeft: 1,
    });
    expect(contractYearOf('2031-03-05', '2033-03-05')).toMatchObject({
      start: '2033-03-05',
      end: '2034-03-05',
    });
  });

  it('a 29 February anniversary falls on the 28th in a common year', () => {
    expect(contractYearOf('2032-02-29', '2033-06-01')).toMatchObject({
      start: '2033-02-28',
      end: '2034-02-28',
    });
  });
});

describe('bandOf', () => {
  const bands = [
    { fromCents: 0, fees: {} },
    { fromCents: 1_000, fees: {} },
    { fromCents: 5_000, fees: {} },
  ];

  it('is the highest band the volume reaches, with the next one up', () => {
    expect(bandOf(bands, 999)).toEqual({ index: 0, next: 1 });
    expect(bandOf(bands, 1_000)).toEqual({ index: 1, next: 2 });
    expect(bandOf(bands, 9_999)).toEqual({ index: 2, next: null });
  });

  it('is no band below every band, and nothing with no bands', () => {
    expect(bandOf([{ fromCents: 10, fees: {} }], 9)).toEqual({ index: null, next: 0 });
    expect(bandOf([], 1)).toEqual({ index: null, next: null });
  });
});

describe('parisDate', () => {
  it('reads the date in Paris, not in UTC', () => {
    // 23:30 UTC on 4 March is 00:30 on 5 March in Paris (UTC+1 in winter).
    expect(parisDate(new Date('2031-03-04T23:30:00Z'))).toBe('2031-03-05');
  });
});
