import { deviceIdOfLeaf, userIdOfLeaf } from './leafIdentity';
import type { SkippedKeyPackageReason } from './skippedKeyPackage';

/**
 * What this device knows, by itself, about the other devices it shares groups with - the TypeScript
 * face of `mls-core/src/device_trust.rs`, which owns the decision.
 *
 * A KeyPackage is checked against the device it was fetched for, and device keys are pinned on
 * first sight: the delivery service chooses the bytes an Add is built from, so a package whose
 * credential names another device, or the right device under a key this device never saw it with,
 * is refused here and in Rust alike. See `docs/wiki/protocols/mls-protocol.md#device-binding`.
 */

/** The two refusals the pin and the binding add to the skip reasons. */
export type DeviceTrustRefusal = Extract<
  SkippedKeyPackageReason,
  'identity-mismatch' | 'signature-key-changed'
>;

/**
 * `vetKeyPackage`'s answer: the package may be added (`first-sight`, `pinned`), or the reason an
 * Add would skip it, as the same wire name.
 */
export type KeyPackageVerdict = 'first-sight' | 'pinned' | SkippedKeyPackageReason;

/** How an admitted leaf's key relates to the pin (`LeafTrust` in Rust). */
export type LeafTrust = 'first-sight' | 'pinned' | 'key-changed';

/**
 * One device admission a merged, signed commit made (or a changed key found in a joined tree).
 *
 * The record a "a device was added" line in a conversation will be built from - whether to show it
 * is the user's decision, so nothing renders it yet. Taken with `IMlsService.takeDeviceEvents`.
 */
export interface DeviceEvent {
  groupId: string;
  /** The epoch the commit created, or the joined tree's. */
  epoch: number;
  /** `userId:deviceId` of the admitted leaf. */
  identity: string;
  /** First 8 bytes of SHA-256 over its signature key, hex. */
  keyFingerprint: string;
  trust: LeafTrust;
  /** The committer's verified identity; `null` for a key change found in a joined tree. */
  addedBy: string | null;
}

/**
 * Who is told about a device event (decided by the user 2026-10-22, refined the same day):
 * - `owner-alert`: the account the device belongs to - "a new device was added to your account", in
 *   the app and as a local notification, whatever kind of group the commit came from;
 * - `contact-line`: everyone else, as a discreet "X added a device" line, in PRIVATE conversations
 *   only (a 1:1 or a group). Never in a community or salon key group, where it would be noise;
 * - `none`: not an admission (a changed key found in a joined tree names no committer), or a
 *   contact's device seen in a community key group.
 *
 * THE ONE PLACE THIS RULE IS WRITTEN. The event itself comes from a signed commit this client merged
 * (`DeviceEvent`), never from a server message: a compromised server would simply not send one.
 */
export type DeviceEventAudience = 'owner-alert' | 'contact-line' | 'none';

/**
 * Applies the rule above to one event.
 *
 * @param ctx.ownUserId - the signed-in account (compared case-insensitively, as identities are).
 * @param ctx.isKeyDistributionGroup - whether `event.groupId` is a community or salon key group
 *   (`IMlsService.isDistributionGroup`); `false` for a 1:1 or a group conversation.
 */
export function deviceEventAudience(
  event: DeviceEvent,
  ctx: { ownUserId: string; isKeyDistributionGroup: boolean }
): DeviceEventAudience {
  if (event.addedBy === null) return 'none';
  if (userIdOfLeaf(event.identity) === ctx.ownUserId.toLowerCase()) return 'owner-alert';
  return ctx.isKeyDistributionGroup ? 'none' : 'contact-line';
}

/**
 * The key a device event is de-duplicated on: one device under one key is announced once, however
 * many groups admitted it.
 */
export function deviceEventKey(event: DeviceEvent): string {
  // The user half is case-insensitive and the device half exact, as `identity_names` reads them.
  return `${userIdOfLeaf(event.identity)}:${deviceIdOfLeaf(event.identity)}|${event.keyFingerprint}`;
}

/** Whether a verdict lets the package be added. */
export function verdictAdmits(verdict: KeyPackageVerdict): verdict is 'first-sight' | 'pinned' {
  return verdict === 'first-sight' || verdict === 'pinned';
}

/** Whether a skip reason is a refusal of the device's identity or key, rather than of the package. */
export function isDeviceTrustRefusal(
  reason: SkippedKeyPackageReason
): reason is DeviceTrustRefusal {
  return reason === 'identity-mismatch' || reason === 'signature-key-changed';
}

/**
 * Thrown by `addMember` when the device's KeyPackage was refused before anything was staged - typed
 * so a caller (and later the UI: "the security key of this device changed") reads the CAUSE from the
 * class, never from a message.
 *
 * `reason` is the refusal; any other verdict (an expired package, a bad signature) is not a trust
 * question and keeps reaching the caller as the ordinary skip it always was.
 */
export class DeviceTrustRefusedError extends Error {
  constructor(
    readonly reason: DeviceTrustRefusal,
    readonly userId: string,
    readonly deviceId: string
  ) {
    super(
      reason === 'identity-mismatch'
        ? `KeyPackage fetched for ${userId}:${deviceId} names another device`
        : `KeyPackage for ${userId}:${deviceId} carries a signature key this device never pinned for it`
    );
    this.name = 'DeviceTrustRefusedError';
  }
}

/**
 * Identities this session already reported a refusal for, with the verdict - so a refusal that a
 * sweep re-derives on every sync is said once at `error` and then at `debug`, rather than becoming
 * a line a reader learns to skip.
 */
const reportedRefusals = new Set<string>();

/**
 * Logs a trust refusal once per identity and reason per session (later repeats at `debug`).
 *
 * @param tag - the caller's log prefix.
 * @returns whether this call was the first report.
 */
export function reportDeviceTrustRefusal(
  tag: string,
  groupId: string,
  error: DeviceTrustRefusedError
): boolean {
  const key = `${error.userId}:${error.deviceId}|${error.reason}`;
  const line = `${tag} ${error.message} - NOT added to ${groupId.slice(0, 8)}... (nothing proves the change; the device re-enrols under a new id if it lost its state)`;
  if (reportedRefusals.has(key)) {
    console.debug(line);
    return false;
  }
  reportedRefusals.add(key);
  console.error(line);
  return true;
}

/** Test seam: forgets which refusals were already reported. */
export function resetReportedDeviceTrustRefusals(): void {
  reportedRefusals.clear();
}
