/**
 * What the server answers when asked for ONE device's KeyPackage, as a type rather than as `null`.
 *
 * **A STATUS CODE IS AN ANSWER, A TRANSPORT FAILURE IS NOT - AND THIS CALL COLLAPSED BOTH INTO
 * `null`.** `fetchDeviceKeyPackage` returned `null` for a 404, for a 500, for a gateway error and
 * for an unreachable network alike, and its caller in `processPendingInvitations` read every one of
 * them as "the device was deregistered" and DELETED the pending membership. A bad minute on one
 * endpoint could therefore retire an invitation that was perfectly valid.
 *
 * **AND THE 404 ITSELF HAD THREE CAUSES REPORTED AS ONE.** Since 2026-09-16 the server refuses to
 * serve an elapsed package - correctly - so "no package" now also means "this device has not been
 * online since its own package died", which is TEMPORARY and resolves itself. Reporting that as
 * "deregistered" is the prose distinction this repository's rules forbid: it is classified at the
 * throw, travels in the 404 body, and is read here as a type.
 */
export type DeviceKeyPackage = {
  keyPackage: Uint8Array;
  deviceId: string;
  deviceName?: string;
  deviceOs?: string;
  deviceAppVersion?: string;
};

/**
 * Why there is no package. The first three mirror `KeyPackageRefusal` in the delivery service;
 * `unrecognized` is a reason the server DID name but this build does not know (a cause added after
 * it shipped - the server deploys before the stores update). It is an answer, but not one this
 * build can judge, so nothing destructive is done on it (see {@link refusalRetiresInvitation}). A
 * 404 naming no reason at all is not the delivery service answering and is `unanswered`, not a
 * refusal.
 */
export type DeviceKeyPackageRefusal = 'revoked' | 'unregistered' | 'expired' | 'unrecognized';

/**
 * The refusals that retire a pending invitation - an ALLOWLIST, because retiring is destructive.
 *
 * `revoked` and `unregistered` are final for this device id. `expired` retires too, because it is
 * self-healing elsewhere: the device mints a fresh package on its next connection and
 * `registerDevice` re-creates the membership. Anything else - `unrecognized` today, any reason
 * added later - KEEPS the invitation and is retried on the next sweep; a server that wants a new
 * reason to retire ships it behind a client floor first.
 */
const RETIRING_REFUSALS: ReadonlySet<DeviceKeyPackageRefusal> = new Set([
  'revoked',
  'unregistered',
  'expired',
]);

/** Whether a refusal may retire the pending invitation it answered (see {@link RETIRING_REFUSALS}). */
export function refusalRetiresInvitation(reason: DeviceKeyPackageRefusal): boolean {
  return RETIRING_REFUSALS.has(reason);
}

/**
 * The answer, or the statement that there was none.
 *
 * `unanswered` is the case the old `null` hid: nothing about the device was established, so a
 * caller must not act on it - least of all destructively.
 */
export type DeviceKeyPackageAnswer =
  | { kind: 'package'; device: DeviceKeyPackage }
  | { kind: 'none'; reason: DeviceKeyPackageRefusal }
  | { kind: 'unanswered'; detail: string };

/**
 * Whether the device can be expected back without anyone doing anything.
 *
 * The one behavioural difference between the refusals, and the reason they are told apart: an
 * elapsed package is replaced by the device itself on its next connection, and `registerDevice`
 * re-creates the pending membership for every group its owner is in. `revoked` and `unregistered`
 * promise nothing of the sort.
 */
export function refusalIsTemporary(reason: DeviceKeyPackageRefusal): boolean {
  return reason === 'expired';
}

/**
 * What the server answers about a device's published signature keys (Graine v2 endorsements).
 * `keys` may be empty, which is an answer; `unanswered` establishes nothing about the device.
 */
export type DeviceSignatureKeys =
  | {
      kind: 'keys';
      keys: Uint8Array[];
      /**
       * Each key the server's history RECORDED, with when it first saw it (ms) - the evidence the
       * new-device notices weigh (`isNewToItsOwner`). A key absent from it predates the history.
       * `undefined` when the server sent no ages at all (an older server), which answers nothing.
       */
      firstSeen?: Array<{ key: Uint8Array; firstSeenAt: number }>;
    }
  | { kind: 'unanswered'; detail: string };

/**
 * What the server's answer says about THE ONE FACT the commit gate reads: does this device have a
 * static KeyPackage row (`deviceAddressability` in the delivery service answers `no_key_package`
 * when it has none).
 *
 * - `published`: a row exists. An ELAPSED package counts, because the gate checks presence and an
 *   elapsed row is exactly the one the device replaces on its own next connection.
 * - `absent`: the server says there is no row (`unregistered`, or a reason this build does not
 *   know) - the fact is false until the device's round publishes.
 * - `revoked`: the id is denylisted; no round of THIS id will ever make it true.
 * - `unknown`: nothing was established (`unanswered`).
 */
export type KeyPackagePublication = 'published' | 'absent' | 'revoked' | 'unknown';

/** Classifies a {@link DeviceKeyPackageAnswer} as a {@link KeyPackagePublication}. */
export function keyPackagePublication(answer: DeviceKeyPackageAnswer): KeyPackagePublication {
  if (answer.kind === 'package') return 'published';
  if (answer.kind === 'unanswered') return 'unknown';
  if (answer.reason === 'expired') return 'published';
  if (answer.reason === 'revoked') return 'revoked';
  return 'absent';
}
