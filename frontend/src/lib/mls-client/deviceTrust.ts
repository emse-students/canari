import { canonicalIdentity, canonicalUserId, deviceIdOfLeaf, userIdOfLeaf } from './leafIdentity';
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

/**
 * What this device has seen of one device's signature key - `IMlsService.pinnedSignatureKeys`, the
 * single source a verifier of a device-key signature reads (`PinView` in Rust).
 */
export interface DevicePin {
  /** The pinned keys: a signature valid under ANY of them was made by a key this device saw. */
  keys: Uint8Array[];
  /**
   * `false` when the pin was written after the device's previous pin was pruned, from whatever tree
   * came next: a signature that FAILS under it is "unverified", never "forged".
   */
  anchored: boolean;
  /**
   * How many merged commits showed the device holding a pinned key since the pin was written. For
   * the refusal memory (`refusedDevices.ts`); a verifier ignores it.
   */
  reaffirmations: number;
}

/** How an admitted leaf's key relates to the pin (`LeafTrust` in Rust). */
export type LeafTrust = 'first-sight' | 'pinned' | 'key-changed';

/**
 * One NEW device a merged, signed commit admitted - a device seen for the first time (`first-sight`)
 * or under a key other than its pin (`key-changed`) - or a changed key found in a joined tree.
 *
 * A device re-added under its pinned key is not an event: a heal or a resync re-adds devices every
 * day, and an event per admission would announce the same device again each time. An external
 * commit's own admission is recorded the same way, once the joiner's commit is merged.
 *
 * The record both new-device notices are built from - the owner's alert and a contact's "X added a
 * device" line (`deviceNotices.svelte.ts`), handed over through `IMlsService.setDeviceEventConsumer`.
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
  /**
   * Whether the admitted device's user already had a leaf in the tree before the commit: the commit
   * gave a member another device, rather than bringing a new member in with theirs. Absent on an
   * event recorded before the field existed, which is never announced.
   */
  memberAlreadyPresent?: boolean;
  /**
   * A MARKER, not a device (`DeviceEvent::events_dropped` in Rust): events of `groupId` were dropped
   * past the queue's bound, so what was handed over about that group is incomplete. It names no
   * identity and announces nothing; the notices say the loss (`deliverDeviceEvents`).
   */
  eventsDropped?: boolean;
}

/**
 * Whether an event is "a device was added" at all - the twin of `DeviceEvent::announces_new_device`
 * in Rust, held to the same table (`mls-core/tests/fixtures/device_notices.json`):
 * - a signed commit admitted it (`addedBy`; a changed key found in a joined tree is no admission);
 * - a `pinned` key is the SAME device coming back - a resync, a heal, a kick and re-add under the
 *   same key, its own commit included - and is never announced;
 * - a first sight is announced only for a user who was already in the conversation: a member joining
 *   with their devices is the member-added line, not one line per device;
 * - a key other than the pinned one is announced wherever it appears, since nothing proves it.
 *
 * WHO signed the commit does not matter (owner, 2026-10-31): a member's further device entering by
 * its own external commit is announced exactly like one a member added.
 */
export function announcesNewDevice(event: DeviceEvent): boolean {
  if (event.addedBy === null) return false;
  switch (event.trust) {
    case 'key-changed':
      return true;
    case 'first-sight':
      return event.memberAlreadyPresent === true;
    case 'pinned':
      return false;
  }
}

/**
 * Whether this event is a NEW PERSON who brought themselves into the group: the commit that admitted
 * the device was signed by that very device (an external commit - the joiner is its own sender), and
 * its user held no leaf before it.
 *
 * Exact from the signed commit alone. A member's Add is signed by a device already in the tree, never
 * by the leaf it admits, so a commit signed by the admitted device whose user was absent can only be
 * the joiner's own external commit. In a conversation that is an entry no member made - the server served the
 * group info and accepted the commit, and nothing else did - so it is reported and written in the
 * conversation (`deviceNotices.svelte.ts`); in a community or salon key group it is how every member
 * enters, and the caller does not ask. An event recorded before `memberAlreadyPresent` existed is
 * never one.
 */
export function entersUninvited(event: DeviceEvent): boolean {
  if (event.addedBy === null || event.memberAlreadyPresent !== false) return false;
  const admitted = canonicalIdentity(event.identity);
  return admitted !== null && canonicalIdentity(event.addedBy) === admitted;
}

/**
 * Who is told about a device event (decided by the user 2026-10-22, refined the same day):
 * - `owner-alert`: the account the device belongs to - "a new device was added to your account", in
 *   the app and as a local notification, whatever kind of group the commit came from;
 * - `contact-line`: everyone else, as a discreet "X added a device" line, in PRIVATE conversations
 *   only (a 1:1 or a group). Never in a community or salon key group, where it would be noise;
 * - `none`: not a new device ({@link announcesNewDevice}: a pinned re-add, a member joining, a
 *   changed key found in a joined tree), the processing device itself, or a contact's device placed
 *   in a community key group.
 *
 * THE KIND OF GROUP IS A PLACEMENT, NOT A FILTER ON WHAT IS RECORDED. The MLS layer records every
 * new device whatever group admitted it - it cannot tell a key group from a conversation, and the
 * first sight of a contact's new device is often in a community they share. The caller asks this
 * rule once per conversation it might write the line in (`deliverDeviceEvents`), so a device first
 * seen in a community still reaches the private conversations shared with its owner.
 *
 * THE ONE PLACE THIS RULE IS WRITTEN for the app; the background engines apply its owner half in Rust
 * (`DeviceEvent::is_owner_alert`) against the same table. The event itself comes from a signed commit
 * this client merged (`DeviceEvent`), never from a server message: a compromised server would simply
 * not send one.
 */
export type DeviceEventAudience = 'owner-alert' | 'contact-line' | 'none';

/**
 * Applies the rule above to one event.
 *
 * @param ctx.ownUserId - the signed-in account (compared case-insensitively, as identities are).
 * @param ctx.ownDeviceId - this device: the device that was added never alerts itself about itself.
 * @param ctx.isKeyDistributionGroup - whether the conversation the line would be written in is a
 *   community or salon key group (`IMlsService.isDistributionGroup`); `false` for a 1:1 or a group.
 */
export function deviceEventAudience(
  event: DeviceEvent,
  ctx: { ownUserId: string; ownDeviceId: string; isKeyDistributionGroup: boolean }
): DeviceEventAudience {
  if (!announcesNewDevice(event)) return 'none';
  // An identity that names no device (`canonicalIdentity`) announces nothing to anyone.
  const identity = canonicalIdentity(event.identity);
  if (identity === null) return 'none';
  if (userIdOfLeaf(identity) === canonicalUserId(ctx.ownUserId)) {
    return deviceIdOfLeaf(identity) === ctx.ownDeviceId ? 'none' : 'owner-alert';
  }
  return ctx.isKeyDistributionGroup ? 'none' : 'contact-line';
}

/**
 * The key a device event is de-duplicated on: one device under one key is announced once, however
 * many groups admitted it. The identity in its canonical form (`canonicalIdentity`), so it equals
 * Rust's `DeviceEvent::notice_key`; `null` for an identity that names no device - such an event has
 * the audience `'none'` and is never keyed.
 */
export function deviceEventKey(event: DeviceEvent): string | null {
  const identity = canonicalIdentity(event.identity);
  return identity === null ? null : `${identity}|${event.keyFingerprint}`;
}

/**
 * The fingerprint `DeviceEvent.keyFingerprint` carries, computed from a key's bytes: the first 8
 * bytes of its SHA-256, hex - Rust's `key_fingerprint`, held to one table
 * (`mls-core/tests/fixtures/key_fingerprints.json`). How the app finds, among a device's published
 * keys, the one an event names.
 */
export async function keyFingerprintOf(key: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', key as BufferSource));
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * How recently a key must have been first seen by the server, against the moment this device
 * learns of it, to be the line "X added a device" - a contact's line AND the line in the account's
 * own conversations. A device a heal brings back into a conversation was registered long before;
 * one its owner just added was registered minutes or hours before. Past it the line is not written
 * - a missed line rather than a false or weeks-late one (user: notices must not become noise). The
 * owner's alert has no such bound (`isNewToItsOwner`, `ownersAlert`).
 */
export const CONTACT_NEW_DEVICE_WINDOW_MS = 7 * 24 * 3600_000;

/**
 * What the server answered about when it first saw one key:
 * - `dated`: its key history recorded the key at `at`;
 * - `before-history`: the server LISTS the key among the device's keys and its history has no date
 *   for it - a positive statement that the key predates the history;
 * - `unknown`: the server answered and said nothing about this key (not listed, or no ages at all).
 */
export type KeyFirstSight =
  | { kind: 'dated'; at: number }
  | { kind: 'before-history' }
  | { kind: 'unknown' };

/**
 * Whether a device this device just saw is NEW TO ITS OWNER - the evidence a notice needs beyond
 * `announcesNewDevice`, because "first sight by THIS device" is not "new": a fresh install, a
 * restore, a pin dropped by the bound, or a heal re-adding a device that was never in a tree this
 * device holds all show old devices for the first time.
 *
 * The evidence is the server's first sight of the device's key (`fetchDeviceSignatureKeys`'
 * `firstSeen`), used ONLY TO SUPPRESS a notice, never to raise one - the signed commit stays the
 * only source of a notice, so A SERVER THAT STAYS SILENT MUST NOT SILENCE IT (2026-10-31 review):
 * - a key the server said nothing about (`unknown`) is new: the commit is the evidence;
 * - a key the server lists with no date (`before-history`) predates its history: old;
 * - a dated key is old when first seen before THIS device enrolled (`ownEnrolledAt`, the first
 *   sight of its own key; `null`, unknown, skips that comparison) - an old device of the account
 *   re-added on a young device says nothing;
 * - the line ("X added a device", a contact's or the account's own) also needs a dated key first
 *   seen within {@link CONTACT_NEW_DEVICE_WINDOW_MS} of `learnedAt`; the owner's alert
 *   (`ownersAlert`) does not, so a device registered since this one enrolled is alerted however late
 *   this device learns of it.
 */
export function isNewToItsOwner(
  sight: KeyFirstSight,
  ctx: { learnedAt: number; ownEnrolledAt: number | null; ownersAlert: boolean }
): boolean {
  if (sight.kind === 'unknown') return true;
  if (sight.kind === 'before-history') return false;
  if (ctx.ownEnrolledAt !== null && sight.at < ctx.ownEnrolledAt) return false;
  return ctx.ownersAlert || sight.at >= ctx.learnedAt - CONTACT_NEW_DEVICE_WINDOW_MS;
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
