/// <reference types="jest" />

import { activeRevocationCutoff, activeRevocationWhere } from './revocation';
import { DEVICE_REVOCATION_TTL_MS } from '../retention.constants';

/**
 * A ban that never lapses is a table that only ever grows, which is the whole reason for the
 * window. What these pin is that the window is applied where the QUESTION is asked - so a row past
 * its date stops banning whether or not the daily purge has run - and that the criteria being asked
 * about survive intact, since every call site passes a different identity.
 */
describe('device revocation window', () => {
  it('puts the cutoff one full TTL in the past', () => {
    const now = Date.UTC(2026, 7, 13, 12, 0, 0);

    expect(activeRevocationCutoff(now).getTime()).toBe(now - DEVICE_REVOCATION_TTL_MS);
  });

  it('lapses after ten years, and not before', () => {
    const tenYears = 10 * 365 * 24 * 60 * 60 * 1000;

    expect(DEVICE_REVOCATION_TTL_MS).toBe(tenYears);
  });

  it('keeps the identity being asked about, whatever shape it has', () => {
    // Sites ask about one device, or about every device of one user, or of several users.
    expect(activeRevocationWhere({ userId: 'u1', deviceId: 'd1' })).toMatchObject({
      userId: 'u1',
      deviceId: 'd1',
    });
    expect(activeRevocationWhere({ userId: 'u1' })).toMatchObject({ userId: 'u1' });
  });

  it('restricts the lookup on revokedAt, so the database applies the bound', () => {
    // In memory would still load every expired row, and the list endpoints read whole users'
    // worth of them.
    const where = activeRevocationWhere({ userId: 'u1' });

    expect(where.revokedAt).toBeDefined();
    expect(where.revokedAt.type).toBe('moreThan');
  });

  it('does not mutate the criteria it was given', () => {
    const criteria = { userId: 'u1', deviceId: 'd1' };

    activeRevocationWhere(criteria);

    expect(criteria).toEqual({ userId: 'u1', deviceId: 'd1' });
  });
});
