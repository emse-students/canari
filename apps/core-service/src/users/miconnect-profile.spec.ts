import { Logger } from '@nestjs/common';
import { cursusViewsOf, parseProfileClaims, PROFILE_CURSUS_BEHIND } from './miconnect-profile';

describe('parseProfileClaims', () => {
  it('reads a student on a campus', () => {
    expect(
      parseProfileClaims({
        miconnect_uuid: 'u-1',
        campus: 'gardanne',
        cursus: [{ formation: 'ISMIN', promo: 2025 }],
        posts: [],
      })
    ).toEqual({
      miconnectUuid: 'u-1',
      campus: 'gardanne',
      cursus: [{ formation: 'ISMIN', promo: 2025 }],
      posts: [],
      alumniLinked: null,
    });
  });

  it('reads cumulative cursus and posts, de-duplicating posts', () => {
    const p = parseProfileClaims({
      campus: 'saint-etienne',
      cursus: [{ formation: 'ICM', promo: 2020 }],
      posts: ['ALUMNI', 'ALUMNI', 'EMSE'],
    });
    expect(p.posts).toEqual(['ALUMNI', 'EMSE']);
  });

  it('turns an absent claim into the empty value, so a vanished claim clears', () => {
    expect(parseProfileClaims({})).toEqual({
      miconnectUuid: null,
      campus: null,
      cursus: [],
      posts: [],
      alumniLinked: null,
    });
  });

  it('drops malformed entries instead of guessing', () => {
    const p = parseProfileClaims({
      campus: 'paris',
      cursus: [{ formation: 'ICM', promo: '2024' }, { formation: '', promo: 2024 }, null],
      posts: ['BOSS'],
    });
    expect(p).toEqual({
      miconnectUuid: null,
      campus: null,
      cursus: [],
      posts: [],
      alumniLinked: null,
    });
  });

  it('reads alumni_linked as a boolean, and anything else as UNKNOWN (D44)', () => {
    expect(parseProfileClaims({ alumni_linked: true }).alumniLinked).toBe(true);
    expect(parseProfileClaims({ alumni_linked: false }).alumniLinked).toBe(false);
    // Absent is unknown, never "not linked": a provider without the claim shows no banner.
    expect(parseProfileClaims({}).alumniLinked).toBeNull();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      expect(parseProfileClaims({ alumni_linked: 'false' }).alumniLinked).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('alumni_linked is not a boolean'));
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a formation no space names, and says so: the person must never become staff', () => {
    // Staff is "a campus and an EMPTY cursus". Dropping the one entry of a student whose formation
    // Canari does not know would hand them the staff public and the whole campus agenda.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const p = parseProfileClaims(
        { campus: 'saint-etienne', cursus: [{ formation: 'icm', promo: 2023 }] },
        'abcd1234'
      );
      expect(p.cursus).toEqual([{ formation: 'icm', promo: 2023 }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[UNKNOWN_FORMATION] abcd1234'));
      warn.mockClear();
      // A known formation is not said.
      parseProfileClaims({ campus: 'gardanne', cursus: [{ formation: 'PDIS', promo: 2025 }] });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * D32 ONLY EVER ADDS: the views a person is priced through are every well-formed cursus entry PLUS
 * the legacy `promo`/`formation` pair when no entry carries it - so somebody the WP3 backfill has not
 * reached is priced exactly as before (`legacy-compatibility.md`).
 */
describe('cursusViewsOf', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  const behind = () =>
    warn.mock.calls.filter(([line]) => String(line).startsWith(PROFILE_CURSUS_BEHIND));

  it('an empty cursus with a legacy pair is ONE view, the pair priced before D32', () => {
    expect(cursusViewsOf({ id: 'aaaaaaaa-1', cursus: [], promo: 2023, formation: 'ICM' })).toEqual([
      { promo: 2023, formation: 'ICM' },
    ]);
    expect(behind()).toHaveLength(1);
    expect(String(behind()[0][0])).toContain('user=aaaaaaaa ');
  });

  it('a promo-less entry is dropped and the legacy pair is the view', () => {
    expect(
      cursusViewsOf({
        id: 'bbbbbbbb-2',
        cursus: [{ formation: 'ICM' }],
        promo: 2024,
        formation: 'ICM',
      })
    ).toEqual([{ promo: 2024, formation: 'ICM' }]);
    expect(warn.mock.calls.some(([l]) => String(l).includes('malformed cursus entry'))).toBe(true);
    expect(behind()).toHaveLength(1);
  });

  it('a legacy pair equal to an entry adds no duplicate and logs nothing', () => {
    expect(
      cursusViewsOf({
        id: 'cccccccc-3',
        cursus: [
          { formation: 'ICM', promo: 2021 },
          { formation: 'ISMIN', promo: 2024 },
        ],
        promo: 2021,
        formation: 'ICM',
      })
    ).toEqual([
      { promo: 2021, formation: 'ICM' },
      { promo: 2024, formation: 'ISMIN' },
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('nothing at all is no view (NO_CURSUS on the reading side), silently', () => {
    expect(cursusViewsOf({ id: 'dddddddd-4', cursus: [], promo: null, formation: null })).toEqual(
      []
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('a cursus that is not a list is no entry, logged at ERROR', () => {
    expect(cursusViewsOf({ id: 'eeeeeeee-5', cursus: null, promo: null, formation: null })).toEqual(
      []
    );
    expect(cursusViewsOf({ id: 'eeeeeeee-6', cursus: { formation: 'ICM' } })).toEqual([]);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('a legacy pair the entries do not carry is ADDED after them', () => {
    expect(
      cursusViewsOf({
        id: 'ffffffff-7',
        cursus: [{ formation: 'ICM', promo: 2024 }],
        promo: 2022,
        formation: 'ISMIN',
      })
    ).toEqual([
      { promo: 2024, formation: 'ICM' },
      { promo: 2022, formation: 'ISMIN' },
    ]);
  });
});
