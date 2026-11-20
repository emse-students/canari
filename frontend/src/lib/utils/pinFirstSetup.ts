import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/**
 * Whether the PIN gate is a FIRST SETUP, answered from this device alone when it can be.
 *
 * The gate used to ask the server (`pin-status`) before drawing anything, and that question needs an
 * access token - so on a cold start the keypad waited for the token refresh AND a second round trip:
 * `[PIN] No device key in vault` at ~1.6 s, the gate on screen at ~2.1 s (Mi 9T, dev estate,
 * 2026-10-11). A device on which the server has ACCEPTED this account's PIN is a returning one.
 *
 * THE PROOF IS THE SERVER'S ANSWER, NEVER THE DEVICE ID (PIN audit, 2026-11-20). The answer was read
 * from the stored MLS device id, which `resolveDeviceId` writes BEFORE `pin-check` - so a first setup
 * abandoned after that point read "returning" for an account with no PIN, and the next PIN typed into
 * an unlock keypad was registered unconfirmed. The marker is written by {@link notePinProven}, only
 * once `pin-check` answered `ok` or `registered`. And should it still be wrong, the server answers an
 * unlock on an account with no PIN `not-set`, which draws the first-setup gate: it chooses wording,
 * never a registration.
 *
 * @returns `false` when this device holds the proof for `userId`; `null` when only the server can say.
 */
export function firstPinSetupFromDevice(
  storage: Pick<Storage, 'getItem'>,
  userId: string
): false | null {
  return storage.getItem(ACCOUNT_KEY.pinProven(userId)) !== null ? false : null;
}

/** Records that the server accepted or registered `userId`'s PIN on this device. */
export function notePinProven(storage: Pick<Storage, 'setItem'>, userId: string): void {
  storage.setItem(ACCOUNT_KEY.pinProven(userId), '1');
}
