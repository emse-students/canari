import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  INSTITUTION_REACH_ASSOCIATION_TYPES,
  INSTITUTION_REACH_INVALID,
  INSTITUTION_REACH_NOT_OFFERED,
  INSTITUTION_REACH_OUTSIDE_AUDIENCE,
  INSTITUTION_REACH_PUBLICS,
  INSTITUTION_REACH_REQUIRED,
  institutionReachOffered,
  isReachComplete,
  reachDraftFrom,
  sameReach,
} from './institutionReach';

const ICM_SE = { formation: 'ICM', campus: 'saint-etienne' };
const ISMIN_GA = { formation: 'ISMIN', campus: 'gardanne' };

describe('the reach of an institution post', () => {
  it('equals libs/contracts/institution-reach.json, the server reads the same file', () => {
    const contract = JSON.parse(
      readFileSync(join(process.cwd(), '..', 'libs', 'contracts', 'institution-reach.json'), 'utf8')
    );
    expect([...INSTITUTION_REACH_ASSOCIATION_TYPES]).toEqual(contract.types);
    expect([...INSTITUTION_REACH_PUBLICS]).toEqual(contract.publics);
    expect({
      required: INSTITUTION_REACH_REQUIRED,
      notOffered: INSTITUTION_REACH_NOT_OFFERED,
      invalid: INSTITUTION_REACH_INVALID,
      outsideAudience: INSTITUTION_REACH_OUTSIDE_AUDIENCE,
    }).toEqual(contract.codes);
  });

  it('is offered to an institution only', () => {
    expect(institutionReachOffered('institution')).toBe(true);
    expect(institutionReachOffered('association')).toBe(false);
    expect(institutionReachOffered('list')).toBe(false);
    expect(institutionReachOffered(undefined)).toBe(false);
    expect(institutionReachOffered(null)).toBe(false);
  });

  it('is complete with at least one space AND a public, never by default', () => {
    expect(isReachComplete({ spaces: [], public: null })).toBe(false);
    expect(isReachComplete({ spaces: [ICM_SE], public: null })).toBe(false);
    expect(isReachComplete({ spaces: [], public: 'all' })).toBe(false);
    expect(isReachComplete({ spaces: [ICM_SE], public: 'students' })).toBe(true);
    expect(isReachComplete(null)).toBe(false);
  });

  it('compares two reaches as sets', () => {
    expect(
      sameReach(
        { spaces: [ICM_SE, ISMIN_GA], public: 'staff' },
        { spaces: [ISMIN_GA, ICM_SE], public: 'staff' }
      )
    ).toBe(true);
    expect(
      sameReach({ spaces: [ICM_SE], public: 'staff' }, { spaces: [ICM_SE], public: 'all' })
    ).toBe(false);
    expect(sameReach(null, null)).toBe(true);
  });

  it('reads a stored or served value defensively', () => {
    expect(reachDraftFrom(null)).toEqual({ spaces: [], public: null });
    expect(
      reachDraftFrom({ spaces: [ICM_SE, { formation: 'ICM' }, 'x'], public: 'everyone' })
    ).toEqual({ spaces: [ICM_SE], public: null });
    expect(reachDraftFrom({ spaces: [ICM_SE], public: 'staff' })).toEqual({
      spaces: [ICM_SE],
      public: 'staff',
    });
  });
});
