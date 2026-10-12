import { MLS_DEVICE_ID_PREFIX } from '$lib/mls-client/wasmPrefetch';

/**
 * Whether the PIN gate is a FIRST SETUP, answered from this device alone when it can be.
 *
 * The gate used to ask the server (`pin-status`) before drawing anything, and that question needs an
 * access token - so on a cold start the keypad waited for the token refresh AND a second round trip:
 * `[PIN] No device key in vault` at ~1.6 s, the gate on screen at ~2.1 s (Mi 9T, dev estate,
 * 2026-10-11). A device that holds an enrolled MLS device id for this user is a RETURNING one, and
 * that is a fact already on disk: `resolveDeviceId` writes it and no sign-out clears it.
 *
 * The answer only chooses the WORDING. Registration is decided by the server at `pin-check`, so a
 * device id minted by a first setup that never reached `pin-check` reads "enter your PIN" and still
 * registers the PIN it is given. And "first setup" is the wrong reading for any device holding a
 * local state: it hides the recovery and the reset (`pinFirstSetupRefuted.test.ts`).
 *
 * @returns `false` when this device holds an enrolled device id for `userId`; `null` when only the
 *   server can say.
 */
export function firstPinSetupFromDevice(
  storage: Pick<Storage, 'getItem'>,
  userId: string
): false | null {
  return storage.getItem(`${MLS_DEVICE_ID_PREFIX}${userId}`) !== null ? false : null;
}
