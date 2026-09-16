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
 * Why there is no package. Mirrors `KeyPackageRefusal` in the delivery service, plus the one case
 * only a client can be in: `unspecified`, a 404 from a server older than the reason field. Treated
 * as the old behaviour was, which is the only reading that cannot be wrong - see
 * `docs/wiki/legacy-compatibility.md`.
 */
export type DeviceKeyPackageRefusal = 'revoked' | 'unregistered' | 'expired' | 'unspecified';

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
