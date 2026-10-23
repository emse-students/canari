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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { m } from '$lib/paraglide/messages';
import {
  LoginFailure,
  hardwareKeyLoginFailure,
  withholdsResetForUnreadKey,
  isExpectedLoginOutcome,
  isRecoverableWithOldPin,
  loginErrorCode,
  type LoginErrorCode,
  provesLocalStateExists,
} from './loginErrors';
import { ServerUnreachableError } from '$lib/utils/fetchOrUnreachable';

/** Every code the union declares. Adding one here is how the exhaustive test below stays honest. */
const EVERY_CODE: LoginErrorCode[] = [
  'pin_mismatch',
  'local_state_unopenable',
  'local_state_sealed_under_old_pin',
  'keystore_empty',
  'device_revoked',
  'server_unreachable',
  'state_written_by_another_tab',
  'hardware_key_unavailable',
  'hardware_key_unreadable',
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
    expect(isExpectedLoginOutcome('local_state_unopenable')).toBe(true);
    expect(isRecoverableWithOldPin('local_state_unopenable')).toBe(true);
  });

  it('and so is a framed state whose header names another key - the old PIN opens it', () => {
    expect(isExpectedLoginOutcome('local_state_sealed_under_old_pin')).toBe(true);
    expect(isRecoverableWithOldPin('local_state_sealed_under_old_pin')).toBe(true);
  });

  it('and an empty keystore, which is a device that has enrolled nothing yet', () => {
    expect(isExpectedLoginOutcome('keystore_empty')).toBe(true);
  });

  it('and a server nobody could reach - a train tunnel is not a defect', () => {
    expect(isExpectedLoginOutcome('server_unreachable')).toBe(true);
  });

  it('and a rotation refused behind another tab - narrated, because the rotation already accused it', () => {
    // One event, one `error`: `rotateDeviceIdentity` says which id stayed stored; the login adds why
    // it stopped, at the level of an outcome rather than a second accusation.
    expect(isExpectedLoginOutcome('state_written_by_another_tab')).toBe(true);
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
      'local_state_unopenable',
      'local_state_sealed_under_old_pin',
      'keystore_empty',
      'server_unreachable',
      'state_written_by_another_tab',
    ]);
  });
});

describe('provesLocalStateExists - is this device new, which is a different question', () => {
  it('a state that would not open proves there IS a state', () => {
    expect(provesLocalStateExists('local_state_unopenable')).toBe(true);
  });

  it('a PIN mismatch does NOT - the verifier is account-wide and says nothing about this disk', () => {
    // THE WHOLE REASON THIS IS NOT `isRecoverableWithOldPin`. The two agree on one code and part on
    // this one, and a caller that reused the first for the second would call a device with nothing
    // on it "not a first setup" on a plain typo.
    expect(isRecoverableWithOldPin('pin_mismatch')).toBe(true);
    expect(provesLocalStateExists('pin_mismatch')).toBe(false);
  });

  it('a revoked device does NOT - that path WIPES the local state before it reports', () => {
    expect(provesLocalStateExists('device_revoked')).toBe(false);
  });

  it('classifies every code the union declares, so a new one cannot arrive undecided', () => {
    for (const code of EVERY_CODE) expect(typeof provesLocalStateExists(code)).toBe('boolean');
    expect(EVERY_CODE.filter(provesLocalStateExists)).toEqual([
      'local_state_unopenable',
      'local_state_sealed_under_old_pin',
      'hardware_key_unavailable',
    ]);
  });
});

describe('hardware_key_unavailable - a phone whose keystore lost the at-rest key', () => {
  it('proves a local state exists, so the reset is offered', () => {
    expect(provesLocalStateExists('hardware_key_unavailable')).toBe(true);
  });

  it('is NOT recoverable with an old PIN - no PIN derives a hardware-held key', () => {
    expect(isRecoverableWithOldPin('hardware_key_unavailable')).toBe(false);
  });

  it('accuses: a keystore losing its entry is never an ordinary outcome', () => {
    expect(isExpectedLoginOutcome('hardware_key_unavailable')).toBe(false);
  });
});

describe('hardware_key_unreadable - a key that could not be read, and may still exist', () => {
  it('withholds the reset and the old-PIN recovery, and accuses', () => {
    expect(withholdsResetForUnreadKey('hardware_key_unreadable')).toBe(true);
    expect(withholdsResetForUnreadKey('hardware_key_unavailable')).toBe(false);
    expect(isRecoverableWithOldPin('hardware_key_unreadable')).toBe(false);
    expect(isExpectedLoginOutcome('hardware_key_unreadable')).toBe(false);
  });
});

describe('hardwareKeyLoginFailure - "lost" only when the read PROVES the key gone', () => {
  const log = () => {};

  it('calls an empty entry or another key in it lost, and offers the reset', () => {
    for (const refusal of ['absent', 'mismatch'] as const) {
      const failure = hardwareKeyLoginFailure(refusal, log);
      expect(failure.code, refusal).toBe('hardware_key_unavailable');
      expect(failure.message, refusal).toBe(m.auth_hardware_key_unavailable());
    }
  });

  it('calls a failed read - a keychain error, a phone not yet unlocked - unreadable: retry, no reset', () => {
    for (const refusal of ['unreadable', 'not-hardware'] as const) {
      const failure = hardwareKeyLoginFailure(refusal, log);
      expect(failure.code, refusal).toBe('hardware_key_unreadable');
      expect(failure.message, refusal).toBe(m.auth_hardware_key_unreadable());
      expect(failure.message, refusal).not.toBe(m.auth_hardware_key_unavailable());
    }
  });

  it('is what every hardware-key failure of the unlock and the recovery throws', () => {
    // WHY A SOURCE TEST: the four sites run inside the login, the migration finish and the PIN
    // recovery, each over a live MLS client and the keystore. What they throw is decided above.
    const source = readFileSync(join(__dirname, 'sessionAuth.ts'), 'utf8');
    expect(source).not.toContain("new LoginFailure('hardware_key_unavailable'");
    expect(source).not.toContain('new LocalizedError(m.auth_hardware_key_unavailable())');
    expect(source.match(/throw hardwareKeyLoginFailure\(/g)?.length).toBe(5);
  });
});
