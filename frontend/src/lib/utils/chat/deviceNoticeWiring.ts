import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { AddMessageToChatOptions, Conversation, ConversationLifecycle } from '$lib/types';
import type { SvelteMap } from 'svelte/reactivity';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import { isMobileTauriRuntime } from '$lib/utils/appVersion';
import { listRefusedDevices, setRefusedDeviceListener } from '$lib/mls-client/refusedDevices';
import { isNewToItsOwner, keyFingerprintOf } from '$lib/mls-client/deviceTrust';
import { canonicalIdentity } from '$lib/mls-client/leafIdentity';
import {
  deliverDeviceEvents,
  forgetDeviceNotices,
  loadDeviceNotices,
  noteRefusedOwnDevices,
  type KeyAge,
} from './deviceNotices.svelte';

/** The MLS service the notices consume events from, while an account is signed in. */
let registeredMls: IMlsService | null = null;
/** The signed-in account and this device, read live, while the notices are registered. */
let registeredSession: Pick<DeviceNoticeSession, 'getUserId' | 'getMyDeviceId'> | null = null;

/**
 * "NOT ME": the owner says a device the alert names is not theirs, and it is REVOKED - the same
 * revocation as the device list's (`deleteDevice`): its id is banned, its logins end, its seats go
 * server-side, and every member's stray collector (`removeStrayLeaves`) takes its leaf out of each
 * conversation, since it holds no seat any more. Never this device itself.
 *
 * @returns whether the server answered the revocation done; a refusal or a failure is logged at a
 *   level that accuses, and the alert stays so the owner can retry or use the list.
 */
export async function revokeNoticedDevice(deviceId: string): Promise<boolean> {
  const mls = registeredMls;
  const session = registeredSession;
  if (!mls || !session) {
    console.error('[DEVICE_NOTICE] "not me" with no account registered - nothing revoked');
    return false;
  }
  if (deviceId === session.getMyDeviceId()) {
    console.error('[DEVICE_NOTICE] "not me" named this very device - refused, nothing revoked');
    return false;
  }
  const short = deviceId.slice(0, 8);
  console.warn(`[DEVICE_NOTICE] the owner says ${short}... is not theirs - revoking it`);
  try {
    const result = await mls.deleteDevice(session.getUserId(), deviceId);
    if (result.status === 'device_deleted') {
      console.warn(
        `[DEVICE_NOTICE] ${short}... revoked: ${result.groupsCleaned} seat(s) withdrawn, its leaves go with the stray collector`
      );
      return true;
    }
    console.error(`[DEVICE_NOTICE] revocation of ${short}... answered status=${result.status}`);
    return false;
  } catch (e) {
    console.error(`[DEVICE_NOTICE] revocation of ${short}... failed: ${String(e).slice(0, 160)}`);
    return false;
  }
}

/**
 * Unbinds the notices from the account that signs out: no more consumer, so the device events stay
 * in the MLS state until an account consumes them, and no more refusal listener.
 */
export function unregisterDeviceNotices(): void {
  registeredMls?.setDeviceEventConsumer(null);
  registeredMls = null;
  registeredSession = null;
  setRefusedDeviceListener(null);
  forgetDeviceNotices();
}

/** What the session hands to {@link registerDeviceNotices}; read live, never captured. */
export interface DeviceNoticeSession {
  getUserId: () => string;
  getMyDeviceId: () => string;
  conversations: SvelteMap<string, Conversation>;
  /** The durable conversation row of a group (`IStorage.getConversation`). */
  storedConversation: (groupId: string) => Promise<{ lifecycle: ConversationLifecycle } | null>;
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    options?: AddMessageToChatOptions
  ) => Promise<void>;
}

/**
 * Claims owner-alert keys in the ledger the phone's background engines share - so a push that
 * replays a commit the app has already shown raises no local notification (`claim_device_notices`,
 * `mobile/device_notice.rs`). Phones only: elsewhere there is no background engine to agree with.
 */
async function claimNativeDeviceNotices(keys: string[]): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  const fresh = await invoke<string[]>('claim_device_notices', { keys });
  console.debug(
    `[DEVICE_NOTICE] native ledger: ${fresh.length} of ${keys.length} key(s) were not yet announced`
  );
}

/**
 * The name the account gave one of its devices, from the device list - best effort: the alert is
 * shown without a name when the list cannot be read, and that is logged.
 */
async function deviceLabelOf(
  mls: IMlsService,
  userId: string,
  deviceId: string
): Promise<string | undefined> {
  try {
    const devices = await mls.fetchUserDevices(userId);
    return devices.find((d) => d.deviceId === deviceId)?.deviceName?.trim() || undefined;
  } catch (e) {
    console.warn('[DEVICE_NOTICE] device list unreadable - alert shown without a name:', e);
    return undefined;
  }
}

/** One device's published keys by fingerprint, and the first sight of those the history dated. */
interface KeyFacts {
  fingerprints: string[];
  dated: Array<{ fingerprint: string; at: number }>;
}

/**
 * The server's keys of one device with their fingerprints and ages, or `unanswered` - a server that
 * could not be reached, or one that sends no ages (it predates them), establishes nothing.
 */
async function keyFactsOf(
  mls: IMlsService,
  userId: string,
  deviceId: string
): Promise<KeyFacts | 'unanswered'> {
  const answer = await mls.fetchDeviceSignatureKeys(userId, deviceId);
  if (answer.kind === 'unanswered' || answer.firstSeen === undefined) {
    console.warn(
      `[DEVICE_NOTICE] key ages of ${deviceId.slice(0, 12)}... unanswered: ${
        answer.kind === 'unanswered' ? answer.detail : 'the server sends none'
      }`
    );
    return 'unanswered';
  }
  const [fingerprints, dated] = await Promise.all([
    Promise.all(answer.keys.map((k) => keyFingerprintOf(k))),
    Promise.all(
      answer.firstSeen.map(async (f) => ({
        fingerprint: await keyFingerprintOf(f.key),
        at: f.firstSeenAt,
      }))
    ),
  ]);
  return { fingerprints, dated };
}

/**
 * When the server first saw the key with `fingerprint` of `userId:deviceId` - the evidence
 * `isNewToItsOwner` weighs. A key with no date predates the server's history.
 */
export async function keyAgeOf(
  mls: IMlsService,
  userId: string,
  deviceId: string,
  fingerprint: string
): Promise<KeyAge> {
  const facts = await keyFactsOf(mls, userId, deviceId);
  if (facts === 'unanswered') return { kind: 'unanswered' };
  const match = facts.dated.find((k) => k.fingerprint === fingerprint);
  return match ? { kind: 'dated', at: match.at } : { kind: 'undated' };
}

/**
 * When THIS device enrolled, as the server saw it: the first sight of its oldest dated key. `null`
 * when none is dated.
 */
export async function ownEnrolledAtOf(
  mls: IMlsService,
  userId: string,
  deviceId: string
): Promise<number | null | 'unanswered'> {
  const facts = await keyFactsOf(mls, userId, deviceId);
  if (facts === 'unanswered') return 'unanswered';
  return facts.dated.length === 0 ? null : Math.min(...facts.dated.map((k) => k.at));
}

/**
 * PHONES: claims, in the ledger the background engines share, every key of this account's other
 * devices that is NOT new by the app's rule (`isNewToItsOwner`) - so a background engine, which has
 * no key ages, never posts "a new device was added" for an old device a heal brings back. Done at
 * registration; a device registered since is left to the background engine and to the app.
 */
async function preclaimOldOwnDevices(mls: IMlsService, userId: string, deviceId: string) {
  try {
    const enrolledAt = await ownEnrolledAtOf(mls, userId, deviceId);
    if (enrolledAt === 'unanswered') return;
    const devices = await mls.fetchUserDevices(userId);
    const old: string[] = [];
    for (const d of devices) {
      if (d.deviceId === deviceId) continue;
      const identity = canonicalIdentity(`${userId}:${d.deviceId}`);
      if (identity === null) continue;
      const facts = await keyFactsOf(mls, userId, d.deviceId);
      if (facts === 'unanswered') continue;
      for (const fingerprint of facts.fingerprints) {
        const at = facts.dated.find((k) => k.fingerprint === fingerprint)?.at ?? null;
        const isNew = isNewToItsOwner(at, {
          learnedAt: Date.now(),
          ownEnrolledAt: enrolledAt,
          isOwnAccount: true,
        });
        if (!isNew) old.push(`${identity}|${fingerprint}`);
      }
    }
    if (old.length > 0) await claimNativeDeviceNotices(old);
    console.log(`[DEVICE_NOTICE] ${old.length} key(s) of this account's older devices pre-claimed`);
  } catch (e) {
    console.error('[DEVICE_NOTICE] pre-claim of the older own devices failed:', e);
  }
}

/**
 * Binds the new-device notices to the signed-in account and makes them the consumer of the MLS
 * layer's device events - which also drains whatever the sealed state already holds - and the
 * listener of the refusals this device records (`refusedDevices.ts`), so a refused device of the
 * account's own is told to its owner.
 */
export function registerDeviceNotices(mls: IMlsService, session: DeviceNoticeSession): void {
  loadDeviceNotices(session.getUserId());
  registeredMls = mls;
  registeredSession = session;
  const onPhone = isMobileTauriRuntime();
  const refusedCtx = () => ({
    ownUserId: session.getUserId(),
    deviceLabel: (deviceId: string) => deviceLabelOf(mls, session.getUserId(), deviceId),
  });
  // The refusals this device already remembers, then each new one as it is recorded.
  void noteRefusedOwnDevices(
    listRefusedDevices({ userId: session.getUserId(), deviceId: session.getMyDeviceId() }),
    refusedCtx()
  );
  setRefusedDeviceListener((identity) => void noteRefusedOwnDevices([identity], refusedCtx()));
  if (onPhone) void preclaimOldOwnDevices(mls, session.getUserId(), session.getMyDeviceId());
  mls.setDeviceEventConsumer((events) =>
    deliverDeviceEvents(events, {
      ownUserId: session.getUserId(),
      ownDeviceId: session.getMyDeviceId(),
      isDistributionGroup: (groupId) => mls.isDistributionGroup(groupId),
      conversations: session.conversations,
      localGroups: () => mls.getLocalGroups(),
      storedConversation: session.storedConversation,
      memberIdentities: (groupId) => mls.getGroupMemberIdentities(groupId),
      removalEpochs: (groupId, userId) => mls.removalEpochs(groupId, userId),
      addMessageToChat: session.addMessageToChat,
      resolveDisplayNames,
      deviceLabel: (deviceId) => deviceLabelOf(mls, session.getUserId(), deviceId),
      keyAge: (userId, deviceId, fingerprint) => keyAgeOf(mls, userId, deviceId, fingerprint),
      ownEnrolledAt: () => ownEnrolledAtOf(mls, session.getUserId(), session.getMyDeviceId()),
      claimNative: onPhone ? claimNativeDeviceNotices : undefined,
      now: () => Date.now(),
    })
  );
}
