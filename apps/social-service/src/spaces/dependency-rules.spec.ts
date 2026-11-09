import { dependencyMismatches, dependencyRefusal, dependencyRefusalOf } from './dependency-rules';

/** The dependency axis as rules (WP-D1, reform 2.2 and 2.5); the SQL twin is in the integration spec. */
describe('dependencyRefusal', () => {
  const bde = { type: 'association' as const, governs: true };
  const club = { type: 'association' as const, governs: false };

  it('always allows no parent, and a non-BDE association or list under a BDE', () => {
    expect(dependencyRefusal({ type: 'institution', governs: true }, null)).toBeNull();
    expect(dependencyRefusal(club, bde)).toBeNull();
    expect(dependencyRefusal({ type: 'list', governs: false }, bde)).toBeNull();
  });

  it('refuses an institution child, a BDE child, and a parent that is not a BDE, in that order', () => {
    expect(dependencyRefusal({ type: 'institution', governs: false }, club)).toBe(
      'DEPENDENCY_INSTITUTION'
    );
    expect(dependencyRefusal(bde, club)).toBe('DEPENDENCY_CHILD_IS_A_BDE');
    expect(dependencyRefusal(club, club)).toBe('DEPENDENCY_PARENT_NOT_A_BDE');
    expect(dependencyRefusal(club, { type: 'institution', governs: true })).toBe(
      'DEPENDENCY_PARENT_NOT_A_BDE'
    );
  });
});

describe('dependencyMismatches', () => {
  it('names each mismatch, and none when the audience sits inside the parent', () => {
    expect(dependencyMismatches(false, ['s1'], ['s1'])).toEqual(['parent_missing']);
    expect(dependencyMismatches(true, [], ['s1'])).toEqual(['parent_governs_nothing']);
    expect(dependencyMismatches(true, ['s1', 's2'], ['s1'])).toEqual([]);
    expect(dependencyMismatches(true, ['s1'], ['s1', 's3'])).toEqual(['reaches_outside_parent']);
    expect(dependencyMismatches(true, ['s1'], ['s3'])).toEqual([
      'reaches_outside_parent',
      'parent_governs_none_of_audience',
    ]);
    expect(dependencyMismatches(true, ['s1'], [])).toEqual([]);
  });
});

describe('dependencyRefusalOf', () => {
  it('reads the code from the structured fields of a 23514, never from a message', () => {
    expect(dependencyRefusalOf({ code: '23514', constraint: 'DEPENDENCY_INSTITUTION' })).toBe(
      'DEPENDENCY_INSTITUTION'
    );
    // TypeORM wraps the driver error.
    expect(
      dependencyRefusalOf({
        driverError: { code: '23514', constraint: 'DEPENDENCY_CHILD_IS_A_BDE' },
      })
    ).toBe('DEPENDENCY_CHILD_IS_A_BDE');
    expect(dependencyRefusalOf({ code: '23514', constraint: 'some_other_check' })).toBeNull();
    expect(dependencyRefusalOf({ code: '23505', constraint: 'DEPENDENCY_INSTITUTION' })).toBeNull();
    expect(dependencyRefusalOf(new Error('DEPENDENCY_INSTITUTION'))).toBeNull();
    expect(dependencyRefusalOf(null)).toBeNull();
  });
});
