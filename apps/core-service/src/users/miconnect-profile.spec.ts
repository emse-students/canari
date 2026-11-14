import { Logger } from '@nestjs/common';
import { parseProfileClaims } from './miconnect-profile';

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
    });
  });

  it('drops malformed entries instead of guessing', () => {
    const p = parseProfileClaims({
      campus: 'paris',
      cursus: [{ formation: 'ICM', promo: '2024' }, { formation: '', promo: 2024 }, null],
      posts: ['BOSS'],
    });
    expect(p).toEqual({ miconnectUuid: null, campus: null, cursus: [], posts: [] });
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
