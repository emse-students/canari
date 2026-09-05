/**
 * A REFUSAL IS AN ANSWER AND A FAILURE IS NOT, AND ONLY ONE OF THEM ACCUSES THE SYSTEM.
 *
 * Every login failure lands in one catch in `sessionAuth.ts`, which logged all of them with
 * `console.error('[INIT] Login failed: ...')` - so a person mistyping their PIN, the most ordinary
 * outcome that screen has, produced the same line as a WASM build that would not load. Measured by
 * `pinrows.mjs --row 2` on 2026-09-05: five deliberate wrong PINs, five console errors, on a product
 * doing exactly the right thing.
 *
 * THE SET IS PINNED RATHER THAN THE PREDICATE'S SHAPE, because the failure mode of this kind of
 * classifier is a code being ADDED to the union and nobody deciding which side it belongs on. The
 * exhaustive case below fails the day that happens, which is the only moment anyone can answer it.
 */
import { describe, it, expect } from 'vitest';
import {
  LoginFailure,
  isExpectedLoginOutcome,
  isRecoverableWithOldPin,
  loginErrorCode,
  type LoginErrorCode,
} from './loginErrors';
import { ServerUnreachableError } from '$lib/utils/fetchOrUnreachable';

/** Every code the union declares. Adding one here is how the exhaustive test below stays honest. */
const EVERY_CODE: LoginErrorCode[] = [
  'pin_mismatch',
  'state_sealed_with_old_key',
  'keystore_empty',
  'device_revoked',
  'server_unreachable',
  'other',
];

describe('loginErrorCode', () => {
  it('reads the code off a LoginFailure', () => {
    expect(loginErrorCode(new LoginFailure('pin_mismatch', 'nope'))).toBe('pin_mismatch');
  });

  it('maps a transport failure from the layer below into this vocabulary', () => {
    // `fetchOrUnreachable` is a generic utility and does not know these codes; the mapping is the
    // seam between the two, and it is the reason a dead radio never reads as `other`.
    expect(loginErrorCode(new ServerUnreachableError('serveur injoignable', new TypeError()))).toBe(
      'server_unreachable'
    );
  });

  it('answers `other` for anything else, including a look-alike message', () => {
    // The type is the contract, never the prose: this is the whole reason the code exists.
    expect(loginErrorCode(new Error('pin_mismatch'))).toBe('other');
    expect(loginErrorCode('pin_mismatch')).toBe('other');
    expect(loginErrorCode(undefined)).toBe('other');
  });
});

describe('isExpectedLoginOutcome', () => {
  it('a PIN that does not match is ordinary - nothing here is broken', () => {
    expect(isExpectedLoginOutcome('pin_mismatch')).toBe(true);
  });

  it('so is a local state sealed under an older key, which has its own recovery flow', () => {
    expect(isExpectedLoginOutcome('state_sealed_with_old_key')).toBe(true);
    expect(isRecoverableWithOldPin('state_sealed_with_old_key')).toBe(true);
  });

  it('and an empty keystore, which is a device that has enrolled nothing yet', () => {
    expect(isExpectedLoginOutcome('keystore_empty')).toBe(true);
  });

  it('and a server nobody could reach - a train tunnel is not a defect', () => {
    expect(isExpectedLoginOutcome('server_unreachable')).toBe(true);
  });

  it('a revoked device is NOT ordinary - the local state is wiped on that path', () => {
    expect(isExpectedLoginOutcome('device_revoked')).toBe(false);
  });

  it('and neither is `other`, the bucket a real defect arrives in', () => {
    // This is the one that must keep accusing, and the reason the other four were taken out of it.
    expect(isExpectedLoginOutcome('other')).toBe(false);
  });

  it('classifies every code the union declares, so a new one cannot arrive undecided', () => {
    for (const code of EVERY_CODE) expect(typeof isExpectedLoginOutcome(code)).toBe('boolean');
    expect(EVERY_CODE.filter(isExpectedLoginOutcome)).toEqual([
      'pin_mismatch',
      'state_sealed_with_old_key',
      'keystore_empty',
      'server_unreachable',
    ]);
  });
});
