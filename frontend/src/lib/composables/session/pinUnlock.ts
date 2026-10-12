import { m } from '$lib/paraglide/messages';
import { beginBootSpan, endBootSpan, timeBootSpan } from '$lib/mls-client/bootBenchmark';
import { LoginFailure } from './loginErrors';
import type { PinSaltAhead } from './pinSaltAhead';

/** What `POST /api/mls/security/pin-check` answers. */
export interface PinCheckAnswer {
  status: 'ok' | 'registered' | 'mismatch' | 'stale-salt';
  resetRequired?: boolean;
}

/**
 * Everything the PIN half of a login needs, passed in so the DECISIONS can be exercised on their own.
 *
 * `loginImpl` runs over a dozen module-level dependencies (MLS init, storage, push, the socket), so
 * a test of its PIN branch used to be a regex over the source. The branch is a security boundary -
 * the device key must never be installed from an unproven PIN - and that is a behaviour, so it now
 * lives here, where a test can answer `mismatch` and watch `installDeviceKey` stay uncalled.
 */
export interface PinUnlockDeps {
  /** The salt asked while the keypad was up, if any (`takePinSaltAhead`). */
  saltAhead: Promise<PinSaltAhead> | undefined;
  /** The salt round trip with this login's own token. */
  fetchSalt: () => Promise<string>;
  /** PBKDF2 verifier for the typed PIN under `salt` (100k iterations). */
  computeVerifier: (salt: string) => Promise<string>;
  /** PBKDF2 at-rest device key for the typed PIN under `salt` (310k iterations). */
  deriveDeviceKey: (salt: string) => Promise<string>;
  /** This device's stored id - reads, decrypts nothing. */
  resolveDeviceId: () => Promise<string>;
  /** The server's answer for this verifier, derived from `salt`. */
  checkPin: (args: { verifier: string; deviceId: string; salt: string }) => Promise<PinCheckAnswer>;
  /** Returns a revoked device to a fresh install. */
  wipeRevokedDevice: () => Promise<void>;
  /** Stores the at-rest key for the session. Called once, and only for a PIN the server accepted. */
  installDeviceKey: (deviceKeyB64: string) => void;
  log: (msg: string) => void;
}

/**
 * The salt this submit uses: the one asked ahead when it arrived, otherwise one asked now.
 *
 * Asking now when the ahead round trip failed is not a second path: it is the round trip every
 * submit made before the keypad asked ahead, with this login's token. Its failure is this submit's
 * own and surfaces as such (`auth_pin_salt_unreachable`), never as the prefetch's.
 */
async function saltForSubmit(deps: PinUnlockDeps): Promise<{ salt: string; source: string }> {
  const taken = deps.saltAhead ? await deps.saltAhead : undefined;
  if (taken && 'salt' in taken)
    return { salt: taken.salt, source: 'asked while the keypad was up' };
  if (taken) {
    deps.log(`[PIN] The salt asked ahead had failed (${taken.failure}) - asking it at submit.`);
  }
  return { salt: await deps.fetchSalt(), source: 'asked at submit' };
}

/**
 * Verifies the typed PIN with the server and installs this device's at-rest key from it.
 *
 * THE DEVICE KEY IS DERIVED DURING THE PIN CHECK, AND ONLY ITS USE WAITS FOR THE ANSWER. Nothing is
 * decrypted with a key from an unproven PIN: the key is installed only after the server accepted the
 * verifier and after the revocation branch. On a mismatch, a revocation or a stale salt it is dropped
 * unread.
 *
 * AFTER THE VERIFIER, NOT BESIDE IT - measured, not assumed (Mi 9T, 2026-10-12, n=6): started
 * together, the two PBKDF2 runs shared the WebCrypto worker and the verifier went from 112 to 215 ms,
 * delaying the check it feeds by the same amount. Started once the verifier is in, the 310k-iteration
 * derivation overlaps only the check's round trip, which waits on the network.
 *
 * A `stale-salt` answer means the account's salt changed (a PIN reset) after this submit's salt was
 * asked. Nothing was compared, so it is not a wrong PIN: the salt is asked again and the check made
 * once more. A second `stale-salt` is a reset racing the retry too, and is refused by name.
 *
 * @returns The installed device key.
 * @throws LoginFailure `pin_mismatch`, `device_revoked` or `pin_salt_rotated`, and `other` for an
 *   answer that is neither `ok` nor `registered` - only those two install the key.
 */
export async function unlockWithPin(deps: PinUnlockDeps): Promise<string> {
  beginBootSpan('pin-salt-fetch');
  let { salt, source } = await saltForSubmit(deps);
  endBootSpan('pin-salt-fetch', { ahead: source !== 'asked at submit' });
  deps.log(`[PIN] Salt ${source}.`);

  for (let attempt = 1; ; attempt += 1) {
    const [verifier, deviceId] = await Promise.all([
      timeBootSpan('pin-verifier-pbkdf2', deps.computeVerifier(salt)),
      timeBootSpan('resolve-device-id', deps.resolveDeviceId()),
    ]);
    const deviceKeyAhead = timeBootSpan('device-key-pbkdf2', deps.deriveDeviceKey(salt));
    // A refusal throws below before this promise is read; its own failure must still leave a line
    // rather than an unhandled rejection.
    deviceKeyAhead.catch((e: unknown) =>
      deps.log(`[PIN] Device key derivation failed: ${String(e)}`)
    );

    beginBootSpan('pin-check-request');
    const answer = await deps.checkPin({ verifier, deviceId, salt });
    endBootSpan('pin-check-request');

    if (answer.status === 'stale-salt') {
      if (attempt >= 2) {
        deps.log('[PIN] The salt changed again during the retry - refusing, nothing was compared.');
        throw new LoginFailure('pin_salt_rotated', m.auth_pin_salt_rotated());
      }
      deps.log(
        '[PIN] The server holds another salt (a PIN reset since it was asked) - asking it again; nothing was compared.'
      );
      salt = await deps.fetchSalt();
      continue;
    }
    if (answer.status === 'mismatch') {
      throw new LoginFailure('pin_mismatch', m.auth_pin_mismatch());
    }
    if (answer.resetRequired === true) {
      // A REVOKED DEVICE IS RETURNED TO A FRESH INSTALL, not merely stripped of its MLS state.
      // Its owner declared it lost or stolen, so leaving its cached media, its drafts, its
      // conversation list and its signed-in session behind answers the wrong question.
      await deps.wipeRevokedDevice();
      deps.log('[SECURITY] Revoked device: signed out and reset to a fresh install.');
      throw new LoginFailure('device_revoked', m.auth_device_revoked_reset());
    }
    if (answer.status !== 'ok' && answer.status !== 'registered') {
      // AN ALLOWLIST, NEVER "ANYTHING BUT A REFUSAL": a body this client does not recognise (an
      // empty `{}`, a status added by a later server) has not said the PIN was accepted, so the key
      // derived from it is dropped unread rather than installed.
      deps.log(
        `[PIN] Unrecognised pin-check answer (status ${String(answer.status)}) - the device key is NOT installed.`
      );
      throw new LoginFailure('other', m.auth_pin_check_unexpected());
    }
    if (answer.status === 'registered') deps.log('First device: PIN registered.');

    // PIN accepted: only now is this device's at-rest key read and installed.
    const deviceKeyB64 = await deviceKeyAhead;
    deps.installDeviceKey(deviceKeyB64);
    return deviceKeyB64;
  }
}
