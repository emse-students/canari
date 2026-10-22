import { SvelteMap } from 'svelte/reactivity';
import { m } from '$lib/paraglide/messages';
import type { AddMessageToChatOptions } from '$lib/types';
import { deviceEventAudience, deviceEventKey, type DeviceEvent } from '$lib/mls-client/deviceTrust';
import { deviceIdOfLeaf, userIdOfLeaf } from '$lib/mls-client/leafIdentity';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/**
 * THE NEW-DEVICE NOTICES (user decision 2026-10-22), built from the device events the MLS layer
 * recorded from signed commits it merged - never from a server message.
 *
 * - **The owner's alert.** A device joining THIS account is "a new device was added to your
 *   account", wherever the commit came from: an in-app notice ({@link pendingDeviceNotices},
 *   rendered by `NewDeviceNotice.svelte`) that survives a reload until it is seen, and - on a phone,
 *   when the app was not running - a local notification raised by the native background engine.
 *   The two share one ledger (`claim_device_notices`), so a push replaying a commit the app has
 *   already shown raises nothing.
 * - **The contact line.** A contact's new device is a discreet system line, "X added a device", in
 *   every 1:1 or group conversation they share with us - wherever the device was first seen - and
 *   never in a community or its key groups, where it would be noise (the user: "ca ferait beaucoup
 *   de bruit").
 * - **The refused device of my own.** A device of this account that this device refused for a
 *   changed key (`refusedDevices.ts`) is never re-added until it is reset: the owner is told so,
 *   with that remedy, until they dismiss it.
 *
 * Who is told is `deviceEventAudience` (the one rule, held to the table Rust shares); a `pinned`
 * re-add - a resync, a heal, a kick and re-add under the same key - and every `none` event produce
 * nothing. Each is announced once: the alert per device and key (a durable set here), the line per
 * conversation (its message id).
 */

/** One "new device on your account" alert, until the user has seen it. */
export interface OwnDeviceNotice {
  /** `deviceEventKey`: the device and its key. */
  key: string;
  deviceId: string;
  /** When this device learned of it (ms). */
  at: number;
  /** The name the account gave the device, when the device list knows it. */
  label?: string;
}

/** What delivering the notices needs from the session, handed in so nothing here pins one. */
export interface DeviceNoticeContext {
  ownUserId: string;
  ownDeviceId: string;
  /** Whether the group is a community or salon key group (`IMlsService.isDistributionGroup`). */
  isDistributionGroup: (groupId: string) => boolean;
  /** The conversation rows by MLS group id - where a contact line may be written. */
  conversations: ReadonlyMap<
    string,
    { conversationType?: string; messages: ReadonlyArray<{ id: string }> }
  >;
  /**
   * Every leaf identity of a group's tree, read locally (`IMlsService.getGroupMemberIdentities`);
   * throws when this device does not hold the group.
   */
  memberIdentities: (groupId: string) => Promise<string[]>;
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    options?: AddMessageToChatOptions
  ) => Promise<void>;
  resolveDisplayNames: (ids: string[]) => Promise<(id: string) => string>;
  /** The account's own name for one of its devices, best effort. */
  deviceLabel: (deviceId: string) => Promise<string | undefined>;
  /** Claims alert keys in the native ledger the background engines share (phones only). */
  claimNative?: (keys: string[]) => Promise<void>;
  now: () => number;
}

/** How many announced keys an account remembers; past it the oldest go (a device long known). */
export const MAX_ANNOUNCED_DEVICE_KEYS = 256;

interface Stored {
  pending: OwnDeviceNotice[];
  announced: string[];
  /** Refused own devices whose notice was dismissed (`dismissRefusedDeviceNotice`). */
  refusedSeen: string[];
}

const EMPTY: Stored = { pending: [], announced: [], refusedSeen: [] };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];

const pending = new SvelteMap<string, OwnDeviceNotice>();
let announced: string[] = [];
const refusedNotices = new SvelteMap<string, RefusedDeviceNotice>();
let refusedSeen: string[] = [];
let boundAccount: string | null = null;

function isNotice(v: unknown): v is OwnDeviceNotice {
  if (!v || typeof v !== 'object') return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.key === 'string' &&
    typeof n.deviceId === 'string' &&
    typeof n.at === 'number' &&
    (n.label === undefined || typeof n.label === 'string')
  );
}

function readStored(userId: string): Stored {
  let raw: string | null;
  try {
    raw = localStorage.getItem(ACCOUNT_KEY.deviceNotices(userId));
  } catch (e) {
    console.error(`[DEVICE_NOTICE] stored notices unreadable, none restored: ${String(e)}`);
    return EMPTY;
  }
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      pending: Array.isArray(parsed.pending) ? parsed.pending.filter(isNotice) : [],
      announced: strings(parsed.announced),
      refusedSeen: strings(parsed.refusedSeen),
    };
  } catch (e) {
    console.error(`[DEVICE_NOTICE] stored notices corrupt, dropped: ${String(e)}`);
    return EMPTY;
  }
}

function writeStored(userId: string): void {
  const stored: Stored = { pending: [...pending.values()], announced, refusedSeen };
  try {
    localStorage.setItem(ACCOUNT_KEY.deviceNotices(userId), JSON.stringify(stored));
  } catch (e) {
    // Shown for this session; only its survival across a reload is lost.
    console.error(`[DEVICE_NOTICE] notices not persisted, a reload will forget them: ${String(e)}`);
  }
}

/** Binds the store to the signed-in account, restoring the alerts it has not seen yet. */
export function loadDeviceNotices(userId: string): void {
  if (!userId || boundAccount === userId) return;
  pending.clear();
  refusedNotices.clear();
  boundAccount = userId;
  const stored = readStored(userId);
  announced = stored.announced;
  refusedSeen = stored.refusedSeen;
  for (const n of stored.pending) pending.set(n.key, n);
  if (stored.pending.length > 0) {
    console.log(`[DEVICE_NOTICE] ${stored.pending.length} unseen new-device alert(s) restored`);
  }
}

/** Unbinds the account (sign-out, switch); its persisted notices stay for its next session. */
export function forgetDeviceNotices(): void {
  pending.clear();
  refusedNotices.clear();
  announced = [];
  refusedSeen = [];
  boundAccount = null;
}

/** The alerts not yet seen, oldest first. Reactive. */
export function pendingDeviceNotices(): OwnDeviceNotice[] {
  return [...pending.values()];
}

/** The user has seen the alert: it goes, and its device stays announced. */
export function dismissDeviceNotice(key: string): void {
  if (!boundAccount || !pending.delete(key)) return;
  console.log('[DEVICE_NOTICE] new-device alert seen');
  writeStored(boundAccount);
}

/** Records an alert for the bound account unless that device and key were announced before. */
function recordOwnDeviceNotice(notice: OwnDeviceNotice): boolean {
  if (!boundAccount) {
    console.error('[DEVICE_NOTICE] no account bound - new-device alert not recorded');
    return false;
  }
  if (announced.includes(notice.key)) return false;
  announced = [...announced, notice.key].slice(-MAX_ANNOUNCED_DEVICE_KEYS);
  pending.set(notice.key, notice);
  writeStored(boundAccount);
  return true;
}

/** The message id of a contact line: one per conversation, device and key. */
function contactLineId(groupId: string, key: string): string {
  return `device-added:${groupId}:${key}`;
}

/**
 * Turns device events into the notices above, one event at a time - a failure costs that event
 * alone and is logged. Owner alerts are claimed in the native ledger (phones) once recorded.
 */
export async function deliverDeviceEvents(
  events: DeviceEvent[],
  ctx: DeviceNoticeContext
): Promise<void> {
  console.debug(`[DEVICE_NOTICE] ${events.length} device event(s) to sort`);
  const claimed: string[] = [];
  // One tree read per conversation per delivery, whatever the number of events (not reactive).
  const trees: Record<string, Promise<string[]>> = {};
  let silent = 0;
  for (const event of events) {
    try {
      // WHO is told, before WHERE: the group that admitted the device is not where a line goes
      // (`writeContactLines` asks the rule once per conversation), so it is not asked here.
      const audience = deviceEventAudience(event, {
        ownUserId: ctx.ownUserId,
        ownDeviceId: ctx.ownDeviceId,
        isKeyDistributionGroup: false,
      });
      const key = deviceEventKey(event);
      if (audience === 'owner-alert') {
        const deviceId = deviceIdOfLeaf(event.identity);
        if (announced.includes(key)) continue;
        const label = await ctx.deviceLabel(deviceId);
        if (recordOwnDeviceNotice({ key, deviceId, at: ctx.now(), label })) {
          console.log(`[DEVICE_NOTICE] a new device was added to this account (${event.trust})`);
          claimed.push(key);
        }
      } else if (audience === 'contact-line') {
        await writeContactLines(event, key, ctx, trees);
      } else {
        silent++;
      }
    } catch (e) {
      console.error('[DEVICE_NOTICE] one device event not delivered:', e);
    }
  }
  if (silent > 0) console.debug(`[DEVICE_NOTICE] ${silent} event(s) announce nothing`);
  if (claimed.length > 0 && ctx.claimNative) {
    try {
      await ctx.claimNative(claimed);
    } catch (e) {
      // The in-app alert is shown; a push replaying the commit may notify once more.
      console.error('[DEVICE_NOTICE] native ledger claim failed:', e);
    }
  }
}

/**
 * Writes the contact line in EVERY 1:1 and group conversation this device shares with the device's
 * owner - wherever the device was first seen, a community key group included, since that is often
 * where a contact's new device shows up first. The audience is asked once per conversation, so a
 * community key group or a salon never gets the line; membership is read from the conversation's
 * own tree (`getGroupMemberIdentities`, the authority on who reads it).
 */
async function writeContactLines(
  event: DeviceEvent,
  key: string,
  ctx: DeviceNoticeContext,
  trees: Record<string, Promise<string[]>>
): Promise<void> {
  const userId = userIdOfLeaf(event.identity);
  let getName: ((id: string) => string) | null = null;
  let written = 0;
  for (const [groupId, convo] of ctx.conversations.entries()) {
    // A channel row is a salon, never a place for the line.
    if ((convo.conversationType ?? 'group') === 'channel') continue;
    const audience = deviceEventAudience(event, {
      ownUserId: ctx.ownUserId,
      ownDeviceId: ctx.ownDeviceId,
      isKeyDistributionGroup: ctx.isDistributionGroup(groupId),
    });
    if (audience !== 'contact-line') continue;
    const messageId = contactLineId(groupId, key);
    if (convo.messages.some((msg) => msg.id === messageId)) continue;
    if (!Object.hasOwn(trees, groupId)) trees[groupId] = ctx.memberIdentities(groupId);
    let leaves: string[];
    try {
      leaves = await trees[groupId];
    } catch (e) {
      // A row whose group this device does not hold (yet) cannot say who is in it.
      console.debug(
        `[DEVICE_NOTICE] tree of ${groupId.slice(0, 8)}... unreadable, no line there: ${String(e)}`
      );
      continue;
    }
    if (!leaves.some((leaf) => userIdOfLeaf(leaf) === userId)) continue;
    getName ??= await ctx.resolveDisplayNames([userId]);
    await ctx.addMessageToChat(
      'system',
      m.chat_system_device_added({ user: getName(userId) }),
      groupId,
      { isSystem: true, messageId }
    );
    written++;
    console.log(`[DEVICE_NOTICE] contact line written in ${groupId.slice(0, 8)}...`);
  }
  if (written === 0) {
    console.debug('[DEVICE_NOTICE] no 1:1 or group conversation shared with that contact');
  }
}

/** One own device this device refused for a changed key: it cannot be re-added until it is reset. */
export interface RefusedDeviceNotice {
  /** `userId:deviceId`, the user half lower-cased (`refusedDevices.ts`). */
  identity: string;
  deviceId: string;
  /** The name the account gave the device, when the device list knows it. */
  label?: string;
}

/** The refused-device notices not yet dismissed, oldest first. Reactive. */
export function pendingRefusedDeviceNotices(): RefusedDeviceNotice[] {
  return [...refusedNotices.values()];
}

/**
 * Tells the owner, in the app, of every device of THEIR account among `identities` (refused by this
 * device for a changed key - `refusedDevices.ts`): such a device is never re-added to anything until
 * its owner resets it, and nothing else would tell them. A contact's refused device is skipped - it
 * is not this account's to reset. A notice dismissed once never comes back.
 */
export async function noteRefusedOwnDevices(
  identities: string[],
  ctx: Pick<DeviceNoticeContext, 'ownUserId' | 'deviceLabel'>
): Promise<void> {
  if (!boundAccount) {
    console.error('[DEVICE_NOTICE] no account bound - refused-device notice not recorded');
    return;
  }
  const own = ctx.ownUserId.toLowerCase();
  for (const raw of identities) {
    const identity = `${userIdOfLeaf(raw)}:${deviceIdOfLeaf(raw)}`;
    if (userIdOfLeaf(raw) !== own || refusedSeen.includes(identity)) continue;
    if (refusedNotices.has(identity)) continue;
    const deviceId = deviceIdOfLeaf(raw);
    try {
      const label = await ctx.deviceLabel(deviceId);
      refusedNotices.set(identity, { identity, deviceId, label });
      console.warn("[DEVICE_NOTICE] one of this account's devices is refused until it is reset");
    } catch (e) {
      console.error('[DEVICE_NOTICE] refused-device notice not recorded:', e);
    }
  }
}

/** The owner has read the refused-device notice: it goes, and is never shown again. */
export function dismissRefusedDeviceNotice(identity: string): void {
  if (!boundAccount || !refusedNotices.delete(identity)) return;
  refusedSeen = [...refusedSeen, identity].slice(-MAX_ANNOUNCED_DEVICE_KEYS);
  console.log('[DEVICE_NOTICE] refused-device notice seen');
  writeStored(boundAccount);
}
