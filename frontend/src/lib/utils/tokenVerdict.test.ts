import { describe, expect, it } from 'vitest';
import {
  SessionEndedByDeviceRevocationError,
  SessionExpiredError,
  SignOutInProgressError,
} from '$lib/stores/auth';
import { IdentitySplitError } from '$lib/stores/tokenIdentity.svelte';
import { tokenVerdictOf } from './tokenVerdict';

/**
 * THE FOUR TYPES THE SESSION'S TOKEN SOURCE THROWS INSTEAD OF A TOKEN, each carrying its verdict as a
 * field set at the throw - what the push registration states as `unauthorized:<cause>`. Built from the
 * REAL classes, so a rename or a lost field fails here instead of reporting `other` (review of #3765).
 */
describe('tokenVerdictOf', () => {
  it('reads the verdict each auth type carries', () => {
    expect(tokenVerdictOf(new SessionExpiredError())).toBe('session-expired');
    expect(
      tokenVerdictOf(new SessionEndedByDeviceRevocationError({ userId: 'u', deviceId: 'd' }))
    ).toBe('device-revoked');
    expect(tokenVerdictOf(new SignOutInProgressError('request'))).toBe('signing-out');
    expect(tokenVerdictOf(new IdentitySplitError({ tokenSub: 'a', localId: 'b' }))).toBe(
      'identity-split'
    );
  });

  it('a revoked device is still a dead session to every instanceof reader', () => {
    expect(new SessionEndedByDeviceRevocationError({ userId: 'u', deviceId: 'd' })).toBeInstanceOf(
      SessionExpiredError
    );
  });

  it('anything else carries none - an unknown value, a bare error, a non-object', () => {
    expect(tokenVerdictOf(Object.assign(new Error('x'), { tokenVerdict: 'forged' }))).toBeNull();
    expect(tokenVerdictOf(new Error('x'))).toBeNull();
    expect(tokenVerdictOf('session-expired')).toBeNull();
    expect(tokenVerdictOf(null)).toBeNull();
  });
});
