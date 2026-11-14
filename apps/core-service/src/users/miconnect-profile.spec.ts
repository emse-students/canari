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

  it('drops a formation no space names, keeping the known entries (audience audit, 2026-11-14)', () => {
    // 'Master' and 'icm' match no space: kept, they made a person with a cursus and no space.
    const p = parseProfileClaims({
      campus: 'saint-etienne',
      cursus: [
        { formation: 'Master', promo: 2024 },
        { formation: 'icm', promo: 2023 },
        { formation: 'PDIS', promo: 2025 },
      ],
    });
    expect(p.cursus).toEqual([{ formation: 'PDIS', promo: 2025 }]);
  });
});
