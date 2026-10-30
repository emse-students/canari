import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { m } from '$lib/paraglide/messages';
import type { AddMessageToChatOptions, ConversationLifecycle } from '$lib/types';
import {
  entersAsUnvouchedDevice,
  entersUninvited,
  CONTACT_NEW_DEVICE_WINDOW_MS,
  deviceEventAudience,
  deviceEventKey,
  isNewToItsOwner,
  type DeviceEvent,
} from '$lib/mls-client/deviceTrust';
import { reportUninvitedEntry, type UninvitedEntryKind } from '$lib/mls-client/uninvitedEntry';
import {
  canonicalIdentity,
  canonicalUserId,
  deviceIdOfLeaf,
  sameDeviceIdentity,
  userIdOfLeaf,
} from '$lib/mls-client/leafIdentity';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import {
  bindHistoryWithheld,
  historyWithheldEntries,
  isWithheldDevice,
  adoptHistoryRecords,
  adoptHistorySeals,
  historySealedGroups,
  historyWithheldWritten,
  inheritsWithholding,
  sealHistoryIn,
  noteDeviceAddedByAMember,
  withholdHistoryFrom,
  type LeafStillIn,
  type WithheldDevice,
} from './historyWithheld';

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

/**
 * The server's first sight of one key: `dated`, `undated` (the key predates the server's history,
 * or is not among the device's published keys at all - old either way), or `unanswered` (the server
 * could not be asked, which establishes nothing).
 */
export type KeyAge = { kind: 'dated'; at: number } | { kind: 'undated' } | { kind: 'unanswered' };

/** What delivering the notices needs from the session, handed in so nothing here pins one. */
export interface DeviceNoticeContext {
  /** The account whose MLS state handed the events over - fixed when the consumer was registered. */
  ownUserId: string;
  ownDeviceId: string;
  /** Whether the group is a community or salon key group (`IMlsService.isDistributionGroup`). */
  isDistributionGroup: (groupId: string) => boolean;
  /** The conversation rows by MLS group id - where a contact line may be written. */
  conversations: ReadonlyMap<
    string,
    {
      conversationType?: string;
      /** The other person of a 1:1 conversation - whose own rejoin is not an uninvited entry. */
      directPeerId?: string;
      messages: ReadonlyArray<{ id: string }>;
    }
  >;
  /**
   * The epochs at which this device saw `userId` leave the group's tree (`IMlsService.removalEpochs`)
   * - a self-admitted entry after one is a member coming back, not a new person.
   */
  removalEpochs: (groupId: string, userId: string) => Promise<number[]>;
  /**
   * The groups this device holds MLS state for (`IMlsService.getLocalGroups`) - the authority on
   * where a contact line is owed, whether or not its conversation row is loaded yet.
   */
  localGroups: () => string[];
  /**
   * Whether {@link localGroups} describes the loaded state (`IMlsService.heldGroupsKnown`): a group's
   * absence from an unfilled list proves nothing, so no record is dropped on it.
   */
  heldGroupsKnown: () => boolean;
  /**
   * The group's conversation row in the DURABLE store (`IStorage.getConversation`), `null` when
   * there is none. It decides whether a held group with no row loaded yet is a conversation the
   * line is owed to: a key group never has one, a deleted conversation has lost it, and a removed
   * one is read-only - none of them may keep a line owed.
   */
  storedConversation: (groupId: string) => Promise<{ lifecycle: ConversationLifecycle } | null>;
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
  /** When the server first saw the device's key with this fingerprint (`fetchDeviceSignatureKeys`). */
  keyAge: (userId: string, deviceId: string, fingerprint: string) => Promise<KeyAge>;
  /** When the server first saw THIS device's own key - its enrolment; `null` if never dated. */
  ownEnrolledAt: () => Promise<number | null | 'unanswered'>;
  /** Claims alert keys in the native ledger the background engines share (phones only). */
  claimNative?: (keys: string[]) => Promise<void>;
  now: () => number;
}

/** How many announced keys an account remembers; past it the oldest go (a device long known). */
export const MAX_ANNOUNCED_DEVICE_KEYS = 256;

/** How many events whose evidence could not be read are kept for the next delivery. */
export const MAX_UNDECIDED_DEVICE_EVENTS = 64;

/** How many uninvited entries whose conversation row is not loaded yet are kept for the next delivery. */
export const MAX_OWED_UNINVITED_LINES = 64;

interface Stored {
  pending: OwnDeviceNotice[];
  announced: string[];
  /** Contact devices (`deviceEventKey`) whose lines were written - never written again. */
  lined: string[];
  /** Events whose key age the server did not answer, decided at the next delivery. */
  undecided: DeviceEvent[];
  /** Contact devices decided NEW whose lines could not all be written yet (`writeContactLines`). */
  owedLines: OwedLine[];
  /**
   * Entries no member made ({@link entersUninvited}) into a conversation whose row was not loaded
   * when the event came: the line is written at the next delivery that finds the row.
   */
  owedUninvited: DeviceEvent[];
  /** The devices no history is answered to (`historyWithheld.ts`). */
  historyWithheld: WithheldDevice[];
  /** The conversations where no history is answered at all (`historyWithheld.ts`). */
  historySealed: string[];
}

/** A contact line decided owed but not yet written everywhere, retried at each delivery. */
interface OwedLine {
  event: DeviceEvent;
  key: string;
  /** When the device was decided new (ms) - past the contact window the line is dropped. */
  since: number;
}

const EMPTY: Stored = {
  pending: [],
  announced: [],
  lined: [],
  undecided: [],
  owedLines: [],
  owedUninvited: [],
  historyWithheld: [],
  historySealed: [],
};

function isOwedLine(v: unknown): v is OwedLine {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return isEvent(o.event) && typeof o.key === 'string' && typeof o.since === 'number';
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];

function isEvent(v: unknown): v is DeviceEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.groupId === 'string' &&
    typeof e.epoch === 'number' &&
    typeof e.identity === 'string' &&
    typeof e.keyFingerprint === 'string' &&
    typeof e.trust === 'string' &&
    (e.addedBy === null || typeof e.addedBy === 'string')
  );
}

const pending = new SvelteMap<string, OwnDeviceNotice>();
let announced: string[] = [];
let lined: string[] = [];
let undecided: DeviceEvent[] = [];
let owedLines: OwedLine[] = [];
/** Refused own devices already logged this session: one accusing line per device, not per drain. */
const refusedLogged = new SvelteSet<string>();
let owedUninvited: DeviceEvent[] = [];
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
      lined: strings(parsed.lined),
      undecided: Array.isArray(parsed.undecided) ? parsed.undecided.filter(isEvent) : [],
      owedLines: Array.isArray(parsed.owedLines) ? parsed.owedLines.filter(isOwedLine) : [],
      owedUninvited: Array.isArray(parsed.owedUninvited)
        ? parsed.owedUninvited.filter(isEvent)
        : [],
      historyWithheld: Array.isArray(parsed.historyWithheld)
        ? parsed.historyWithheld.filter(isWithheldDevice)
        : [],
      historySealed: strings(parsed.historySealed),
    };
  } catch (e) {
    console.error(`[DEVICE_NOTICE] stored notices corrupt, dropped: ${String(e)}`);
    return EMPTY;
  }
}

function writeStored(userId: string): void {
  // SEALS AND RECORDS ARE MERGED, NEVER OVERWRITTEN: another tab (or `sealInAccount` for an account
  // this tab does not hold) may have sealed a conversation or withheld a device in the stored copy
  // since it was read. A seal is never lifted, so the union is the truth; a record is withdrawn only
  // by what this tab decided (`adoptHistoryRecords`). This tab adopts both.
  const elsewhere = readStoredHistory(userId);
  const sealedHere = new Set(historySealedGroups());
  const sealedElsewhere = elsewhere.sealed.filter((g) => !sealedHere.has(g));
  if (sealedElsewhere.length > 0) adoptHistorySeals(sealedElsewhere);
  adoptHistoryRecords(elsewhere.withheld);
  const stored: Stored = {
    pending: [...pending.values()],
    announced,
    lined,
    undecided,
    owedLines,
    owedUninvited,
    historyWithheld: historyWithheldEntries(),
    historySealed: historySealedGroups(),
  };
  try {
    localStorage.setItem(ACCOUNT_KEY.deviceNotices(userId), JSON.stringify(stored));
    historyWithheldWritten();
  } catch (e) {
    // Shown for this session; only its survival across a reload is lost.
    console.error(`[DEVICE_NOTICE] notices not persisted, a reload will forget them: ${String(e)}`);
  }
}

/** The seals and withheld records in `userId`'s stored copy as it is now ({@link writeStored}). */
function readStoredHistory(userId: string): { sealed: string[]; withheld: WithheldDevice[] } {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY.deviceNotices(userId));
    if (!raw) return { sealed: [], withheld: [] };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      sealed: strings(parsed.historySealed),
      withheld: Array.isArray(parsed.historyWithheld)
        ? parsed.historyWithheld.filter(isWithheldDevice)
        : [],
    };
  } catch (e) {
    console.error(
      `[HISTORY_WITHHELD] stored history record unreadable, nothing merged: ${String(e)}`
    );
    return { sealed: [], withheld: [] };
  }
}

/** Binds the store to the signed-in account, restoring the alerts it has not seen yet. */
export function loadDeviceNotices(userId: string): void {
  if (!userId || boundAccount === userId) return;
  pending.clear();
  refusedLogged.clear();
  boundAccount = userId;
  const stored = readStored(userId);
  announced = stored.announced;
  lined = stored.lined;
  undecided = stored.undecided;
  owedLines = stored.owedLines;
  owedUninvited = stored.owedUninvited;
  bindHistoryWithheld(
    stored.historyWithheld,
    () => {
      if (boundAccount === userId) writeStored(userId);
    },
    stored.historySealed
  );
  for (const n of stored.pending) pending.set(n.key, n);
  if (stored.pending.length > 0) {
    console.log(`[DEVICE_NOTICE] ${stored.pending.length} unseen new-device alert(s) restored`);
  }
}

/** Unbinds the account (sign-out, switch); its persisted notices stay for its next session. */
export function forgetDeviceNotices(): void {
  pending.clear();
  refusedLogged.clear();
  announced = [];
  lined = [];
  undecided = [];
  owedLines = [];
  owedUninvited = [];
  bindHistoryWithheld([], null);
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

/**
 * Keeps an event whose evidence the server did not answer for the next delivery - a notice is
 * neither raised without the evidence nor lost for want of it. Bounded; past it the oldest go.
 */
function keepUndecided(event: DeviceEvent): void {
  undecided = [...undecided, event].slice(-MAX_UNDECIDED_DEVICE_EVENTS);
  console.warn('[DEVICE_NOTICE] key age unanswered - the event waits for the next delivery');
}

/** The message id of a contact line: one per conversation, device and key. */
function contactLineId(groupId: string, key: string): string {
  return `device-added:${groupId}:${key}`;
}

/**
 * Turns device events into the notices above, one event at a time - a failure costs that event
 * alone and is logged. Owner alerts are claimed in the native ledger (phones) once recorded.
 *
 * @returns whether who is withheld was decided for every event (`settleDeviceEvents`): `false` when
 * the account the events belong to is not the one bound - a history answer then refuses, and their
 * conversations are sealed in that account's record ({@link sealInAccount}).
 */
export async function deliverDeviceEvents(
  handed: DeviceEvent[],
  ctx: DeviceNoticeContext
): Promise<boolean> {
  if (boundAccount !== ctx.ownUserId) {
    sealInAccount(ctx.ownUserId, handed, 'its device events reached no bound account', ctx);
    return false;
  }
  // A GROUP WHOSE EVENTS THE QUEUE DROPPED (`eventsDropped`) has an incomplete record: an entry may
  // be there without what it then added. No history is answered in it - fail closed.
  const delivered: DeviceEvent[] = [];
  for (const event of handed) {
    if (event.eventsDropped !== true) delivered.push(event);
    else sealUnlessKeyGroup(event.groupId, 'device events were dropped', ctx);
  }
  // An empty hand-over with nothing parked is every drain's: nothing to do, nothing to say.
  if (
    delivered.length === 0 &&
    undecided.length === 0 &&
    owedLines.length === 0 &&
    owedUninvited.length === 0
  ) {
    return true;
  }
  // One tree read per conversation per delivery, whatever the number of events (not reactive).
  const trees: Record<string, Promise<string[]>> = {};
  // Read before the retry: a retry that settles or expires every owed line leaves nothing parked,
  // and the stored copy must still lose them.
  const hadOwedLines = owedLines.length > 0;
  await retryOwedLines(ctx, trees);
  // WHO IS WITHHELD IS DECIDED FIRST, ONE EVENT AT A TIME, IN COMMIT ORDER (`historyWithheld.ts`).
  // A drain hands over every commit it merged at once, so an unvouched entry and an Add made by that
  // very device can arrive together: each event is marked against the record as the events before it
  // left it. And it is decided here whether or not the conversation row is loaded - the line waits
  // for the row (`noteUninvitedEntries`), the withholding does not.
  const events: DeviceEvent[] = [];
  const ordered = inCommitOrder(delivered);
  for (const raw of ordered) {
    // AN ACCOUNT SWITCH MID-DELIVERY ends it: these events are the other account's, already taken
    // from its state - what is left of them seals their conversations in that account's record.
    if (boundAccount !== ctx.ownUserId) {
      sealInAccount(
        ctx.ownUserId,
        ordered.slice(events.length),
        'the account changed before its device events were decided',
        ctx
      );
      return false;
    }
    // WHAT AN UNVOUCHED DEVICE ADDS IS UNVOUCHED TOO: marked before anything decides on the event,
    // so the line, the report and the withholding all follow.
    const event = inheritsWithholding(raw) ? { ...raw, addedByUnvouched: true } : raw;
    events.push(event);
    // One event that throws costs itself alone, never the rest of the batch.
    try {
      // A member's Add of a device vouches for it: history withheld from it is answered again.
      noteDeviceAddedByAMember(event.groupId, event.identity, event.addedBy);
      if (withheldOnSight(event, ctx)) {
        await withholdHistoryFrom(
          event.groupId,
          event.identity,
          event.keyFingerprint,
          leafStillIn(ctx, trees)
        );
      }
    } catch (e) {
      // FAIL CLOSED: an event whose withholding was not decided may be an entry - its group answers
      // no history from now on.
      console.error(
        `[HISTORY_WITHHELD] withholding not decided for one device event in ${event.groupId.slice(0, 8)}...:`,
        e
      );
      sealUnlessKeyGroup(event.groupId, 'a device event could not be decided', ctx);
    }
    // A switch DURING this event: what it wrote went to the account now bound, so it is sealed too.
    if (boundAccount !== ctx.ownUserId) {
      sealInAccount(
        ctx.ownUserId,
        ordered.slice(events.length - 1),
        'the account changed while its device events were decided',
        ctx
      );
      return false;
    }
  }
  await noteUninvitedEntries(events, ctx);
  // The events a previous delivery could not decide come first, oldest first.
  const retried = undecided;
  undecided = [];
  const all = [...retried, ...events];
  console.debug(
    `[DEVICE_NOTICE] ${events.length} device event(s) to sort (+${retried.length} undecided)`
  );
  const claimed: string[] = [];
  let ownEnrolled: Promise<number | null | 'unanswered'> | null = null;
  let silent = 0;
  let old = 0;
  for (const event of all) {
    try {
      // WHO is told, before WHERE: the group that admitted the device is not where a line goes
      // (`writeContactLines` asks the rule once per conversation), so it is not asked here.
      const audience = deviceEventAudience(event, {
        ownUserId: ctx.ownUserId,
        ownDeviceId: ctx.ownDeviceId,
        isKeyDistributionGroup: false,
      });
      const key = deviceEventKey(event);
      if (audience === 'none' || key === null) {
        silent++;
        continue;
      }
      if ((audience === 'owner-alert' ? announced : lined).includes(key)) continue;
      if (audience === 'contact-line' && owedLines.some((o) => o.key === key)) continue;
      // THE EVIDENCE THAT THE DEVICE IS NEW TO ITS OWNER, not merely new to this device.
      ownEnrolled ??= ctx.ownEnrolledAt();
      const [age, enrolledAt] = await Promise.all([
        ctx.keyAge(
          userIdOfLeaf(event.identity),
          deviceIdOfLeaf(event.identity),
          event.keyFingerprint
        ),
        ownEnrolled,
      ]);
      if (age.kind === 'unanswered' || enrolledAt === 'unanswered') {
        keepUndecided(event);
        continue;
      }
      const isNew = isNewToItsOwner(age.kind === 'dated' ? age.at : null, {
        learnedAt: ctx.now(),
        ownEnrolledAt: enrolledAt,
        isOwnAccount: audience === 'owner-alert',
      });
      if (!isNew) {
        old++;
        continue;
      }
      if (audience === 'owner-alert') {
        const deviceId = deviceIdOfLeaf(event.identity);
        const label = await ctx.deviceLabel(deviceId);
        if (recordOwnDeviceNotice({ key, deviceId, at: ctx.now(), label })) {
          console.log(`[DEVICE_NOTICE] a new device was added to this account (${event.trust})`);
          claimed.push(key);
        }
      } else {
        settleContactLine(
          { event, key, since: ctx.now() },
          await writeContactLines(event, key, ctx, trees)
        );
        writeStored(boundAccount);
      }
    } catch (e) {
      console.error('[DEVICE_NOTICE] one device event not delivered:', e);
    }
  }
  if (silent > 0) console.debug(`[DEVICE_NOTICE] ${silent} event(s) announce nothing`);
  if (old > 0) {
    console.log(`[DEVICE_NOTICE] ${old} device(s) seen for the first time here are not new`);
  }
  if (retried.length > 0 || undecided.length > 0 || hadOwedLines || owedLines.length > 0) {
    writeStored(boundAccount);
  }
  if (claimed.length > 0 && ctx.claimNative) {
    try {
      await ctx.claimNative(claimed);
    } catch (e) {
      // The in-app alert is shown; a push replaying the commit may notify once more.
      console.error('[DEVICE_NOTICE] native ledger claim failed:', e);
    }
  }
  return true;
}

/** The events, stably ordered by epoch - the order their commits were merged in. */
function inCommitOrder(events: readonly DeviceEvent[]): DeviceEvent[] {
  return events
    .map((event, i) => ({ event, i }))
    .sort((a, b) => a.event.epoch - b.event.epoch || a.i - b.i)
    .map(({ event }) => event);
}

/**
 * Whether no history is answered to this event's device from now on: an entry no member made by a
 * device of a member ({@link entersAsUnvouchedDevice}, a mark inherited from its committer included),
 * or a device that changed its own key by its own commit (an id still in the tree, under a key nothing
 * proves - its notice is the key-change one, not a line). Never this device itself, never in a key
 * group this session knows as one.
 */
function withheldOnSight(event: DeviceEvent, ctx: DeviceNoticeContext): boolean {
  if (ctx.isDistributionGroup(event.groupId)) return false;
  if (sameDeviceIdentity(event.identity, `${ctx.ownUserId}:${ctx.ownDeviceId}`)) return false;
  if (entersAsUnvouchedDevice(event)) return true;
  return (
    event.trust === 'key-changed' &&
    event.addedBy !== null &&
    sameDeviceIdentity(event.addedBy, event.identity)
  );
}

/**
 * Seals `groupId` (`sealHistoryIn`) unless it is a community or salon key group, which answers no
 * history to anyone and whose record would only grow.
 */
function sealUnlessKeyGroup(groupId: string, why: string, ctx: DeviceNoticeContext): void {
  if (ctx.isDistributionGroup(groupId)) {
    console.debug(`[HISTORY_WITHHELD] key group ${groupId.slice(0, 8)}... not sealed (${why})`);
    return;
  }
  sealHistoryIn(groupId, why);
}

/**
 * Seals, in `userId`'s record, every conversation `events` name - events taken from that account's
 * state that were not decided, and that no later take will hand over again. Bound or not, the
 * account's next answer there refuses: written through the bound record, or into its stored copy.
 * Key groups are skipped ({@link sealUnlessKeyGroup}).
 */
function sealInAccount(
  userId: string,
  events: DeviceEvent[],
  why: string,
  ctx: DeviceNoticeContext
): void {
  const groups = [
    ...new Set(events.map((e) => e.groupId).filter((g) => !ctx.isDistributionGroup(g))),
  ];
  console.error(
    `[DEVICE_NOTICE] ${events.length} device event(s) of another account not decided (${why}) - ${groups.length} conversation(s) sealed in its record`
  );
  if (groups.length === 0) return;
  if (boundAccount === userId) {
    for (const groupId of groups) sealHistoryIn(groupId, why);
    return;
  }
  const stored = readStored(userId);
  const historySealed = [...new Set([...stored.historySealed, ...groups])];
  try {
    localStorage.setItem(
      ACCOUNT_KEY.deviceNotices(userId),
      JSON.stringify({ ...stored, historySealed })
    );
  } catch (e) {
    console.error(`[HISTORY_WITHHELD] seals of an unbound account not persisted: ${String(e)}`);
  }
}

/**
 * Reads, from the conversation's own tree, whether a device still holds a leaf there - one read per
 * conversation per delivery (`trees`), whatever the number of records checked.
 */
function leafStillIn(
  ctx: DeviceNoticeContext,
  trees: Record<string, Promise<string[]>>
): LeafStillIn {
  return async (groupId, identity) => {
    // A conversation this device no longer holds: its records name nobody it could answer. Only a
    // listing known to describe the state says so - an unfilled one proves nothing, and the tree is
    // read as for any conversation.
    if (!ctx.localGroups().includes(groupId) && ctx.heldGroupsKnown()) return 'group-not-held';
    if (!Object.hasOwn(trees, groupId)) trees[groupId] = ctx.memberIdentities(groupId);
    try {
      return (await trees[groupId]).some((leaf) => sameDeviceIdentity(leaf, identity));
    } catch (e) {
      console.warn(
        `[HISTORY_WITHHELD] tree of ${groupId.slice(0, 8)}... unreadable, its record is kept: ${String(e)}`
      );
      return 'unreadable';
    }
  };
}

/** The message id of an uninvited-entry line: one per conversation, device and key. */
function uninvitedLineId(groupId: string, key: string): string {
  return `uninvited-entry:${groupId}:${key}`;
}

/**
 * Whether an event is an entry no member made: a new person's ({@link entersUninvited}), or a
 * never-seen device of a member that admitted itself ({@link entersAsUnvouchedDevice}).
 */
function isSelfAdmittedEntry(event: DeviceEvent): boolean {
  return entersUninvited(event) || entersAsUnvouchedDevice(event);
}

/**
 * Writes, in the conversation itself, every entry no member made among `events` - a NEW PERSON's
 * ({@link entersUninvited}) or a never-seen DEVICE of a member that admitted itself
 * ({@link entersAsUnvouchedDevice}) - and retries the ones owed from an earlier delivery. Every decided
 * entry is reported to the server with its kind (`reportUninvitedEntry`, once per session) - that
 * report is the measurement.
 *
 * Decided on the conversation ROW, loaded or durable, never on `isDistributionGroup`: that set is
 * session-local and may not name a key group yet at start-up, and a key group - where an external
 * commit is how every member enters - never has a row. A row not loaded yet keeps the entry owed,
 * durably, and it is decided and reported when the row is found; a group with no live row is not a
 * conversation and nothing is said.
 */
async function noteUninvitedEntries(
  events: DeviceEvent[],
  ctx: DeviceNoticeContext
): Promise<void> {
  const retried = owedUninvited;
  const fresh = events.filter(isSelfAdmittedEntry);
  if (retried.length === 0 && fresh.length === 0) return;
  owedUninvited = [];
  for (const event of [...retried, ...fresh]) {
    try {
      const decided = await decideUninvitedEntry(event, ctx);
      if (decided === 'not-a-conversation') {
        console.debug(
          `[DEVICE_NOTICE] self-admitted entry in ${event.groupId.slice(0, 8)}... - not a conversation, nothing to say`
        );
        continue;
      }
      if (decided === 'owed') {
        owedUninvited = [...owedUninvited, event].slice(-MAX_OWED_UNINVITED_LINES);
        continue;
      }
      reportUninvitedEntry(event, decided.kind);
      if (decided.kind === 'new-person' || decided.kind === 'unvouched-device') {
        await writeUninvitedLine(event, decided.kind, decided.convo, ctx);
      }
    } catch (e) {
      // Nothing is lost - the entry is kept, durably, and decided at the next delivery - so this is
      // a warning: what accuses is the entry itself, once decided (`reportUninvitedEntry`).
      console.warn('[DEVICE_NOTICE] uninvited entry not decided, owed to the next delivery:', e);
      owedUninvited = [...owedUninvited, event].slice(-MAX_OWED_UNINVITED_LINES);
    }
  }
  if (boundAccount) writeStored(boundAccount);
}

type NoticeConversation =
  DeviceNoticeContext['conversations'] extends ReadonlyMap<string, infer C> ? C : never;

/**
 * Whether an entry no member made is said, and as what ({@link UninvitedEntryKind}).
 *
 * A LEGITIMATE REJOIN IS NOT WRITTEN: the other person of a 1:1 conversation (`direct-peer`), or a
 * user this device SAW leave the tree before the entering epoch (`returning`, from the departures the
 * MLS layer recorded - `removalEpochs`). Both are reported with their kind, so the count still says
 * how often they happen. Anything else is a `new-person` and is written. A departure this device
 * never saw cannot be known here, so a returning member reads as `new-person` on such a device.
 *
 * A departure read that fails throws: the entry stays owed to the next delivery rather than being
 * guessed either way.
 */
async function decideUninvitedEntry(
  event: DeviceEvent,
  ctx: DeviceNoticeContext
): Promise<
  'owed' | 'not-a-conversation' | { kind: UninvitedEntryKind; convo: NoticeConversation }
> {
  // A key group, when this session already knows it as one: every member enters it this way.
  if (ctx.isDistributionGroup(event.groupId)) return 'not-a-conversation';
  const convo = ctx.conversations.get(event.groupId);
  if (!convo) {
    return (await isLiveStoredConversation(event.groupId, ctx)) ? 'owed' : 'not-a-conversation';
  }
  const type = convo.conversationType ?? 'group';
  if (type === 'channel') return 'not-a-conversation';
  // A member's never-seen device that let itself in: in a 1:1 too - the peer's further device is a
  // member's Add as much as anyone's (`automaticAdmission`).
  // This very device entering is its own join, never an accusation of itself.
  if (entersAsUnvouchedDevice(event)) {
    const self = canonicalIdentity(`${ctx.ownUserId}:${ctx.ownDeviceId}`);
    if (canonicalIdentity(event.identity) === self) return 'not-a-conversation';
    return { kind: 'unvouched-device', convo };
  }
  const userId = canonicalUserId(userIdOfLeaf(event.identity));
  if (type === 'direct' && convo.directPeerId && canonicalUserId(convo.directPeerId) === userId) {
    return { kind: 'direct-peer', convo };
  }
  const departures = await ctx.removalEpochs(event.groupId, userId);
  if (departures.some((epoch) => epoch < event.epoch)) return { kind: 'returning', convo };
  return { kind: 'new-person', convo };
}

async function writeUninvitedLine(
  event: DeviceEvent,
  kind: 'new-person' | 'unvouched-device',
  convo: NoticeConversation,
  ctx: DeviceNoticeContext
): Promise<void> {
  const key = deviceEventKey(event) ?? event.identity;
  const messageId = uninvitedLineId(event.groupId, key);
  if (convo.messages.some((msg) => msg.id === messageId)) return;
  const userId = userIdOfLeaf(event.identity);
  const getName = await ctx.resolveDisplayNames([userId]);
  const user = getName(userId);
  await ctx.addMessageToChat(
    'system',
    kind === 'unvouched-device'
      ? m.chat_system_unvouched_device_entry({ user })
      : m.chat_system_uninvited_entry({ user }),
    event.groupId,
    { isSystem: true, messageId }
  );
  console.warn(
    `[DEVICE_NOTICE] uninvited-entry line (${kind}) written in ${event.groupId.slice(0, 8)}...`
  );
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
): Promise<boolean> {
  const userId = userIdOfLeaf(event.identity);
  const held = new Set(ctx.localGroups());
  let getName: ((id: string) => string) | null = null;
  let written = 0;
  let owed = false;
  const holdsContact = async (groupId: string): Promise<boolean | 'unreadable'> => {
    if (!Object.hasOwn(trees, groupId)) trees[groupId] = ctx.memberIdentities(groupId);
    try {
      return (await trees[groupId]).some((leaf) => userIdOfLeaf(leaf) === userId);
    } catch (e) {
      console.warn(
        `[DEVICE_NOTICE] tree of ${groupId.slice(0, 8)}... unreadable, its line stays owed: ${String(e)}`
      );
      return 'unreadable';
    }
  };
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
    // A row whose group this device does not hold has no tree to say who is in it, and no line.
    if (!held.has(groupId)) continue;
    const holds = await holdsContact(groupId);
    if (holds === 'unreadable') {
      owed = true;
      continue;
    }
    if (!holds) continue;
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
  // A HELD group with no row loaded yet (the start-up drain may run before the rows load) is a line
  // still owed if its DURABLE row says it is a live conversation and the contact sits in its tree.
  // The durable row, not `isDistributionGroup`: that set is session-local and may not name a key
  // group yet at start-up, and a deleted conversation's lingering state is in no set at all.
  for (const groupId of held) {
    if (ctx.conversations.has(groupId)) continue;
    if (!(await isLiveStoredConversation(groupId, ctx))) continue;
    if ((await holdsContact(groupId)) === false) continue;
    owed = true;
    console.debug(`[DEVICE_NOTICE] ${groupId.slice(0, 8)}... has no row yet - its line stays owed`);
  }
  if (written === 0 && !owed) {
    console.debug('[DEVICE_NOTICE] no 1:1 or group conversation shared with that contact');
  }
  return owed;
}

/**
 * Whether the durable store holds a live (not removed) conversation row for `groupId`. A store that
 * cannot be read establishes nothing, so the group counts as live and its line stays owed - bounded
 * by the contact window like every owed line.
 */
async function isLiveStoredConversation(
  groupId: string,
  ctx: DeviceNoticeContext
): Promise<boolean> {
  try {
    const row = await ctx.storedConversation(groupId);
    if (row === null) {
      console.debug(`[DEVICE_NOTICE] ${groupId.slice(0, 8)}... has no stored row - no line owed`);
      return false;
    }
    return row.lifecycle !== 'removed';
  } catch (e) {
    console.warn(
      `[DEVICE_NOTICE] stored row of ${groupId.slice(0, 8)}... unreadable, its line stays owed: ${String(e)}`
    );
    return true;
  }
}

/**
 * Settles one contact device after a pass of {@link writeContactLines}: LINED for good when no line
 * is owed any more, otherwise kept (durably, bounded) for the next delivery - which every hand-over
 * of the MLS layer is, an empty one included. A line is never marked written before it was.
 */
function settleContactLine(line: OwedLine, owed: boolean): void {
  owedLines = owedLines.filter((o) => o.key !== line.key);
  if (owed) {
    const kept = [...owedLines, line];
    const dropped = kept.length - MAX_UNDECIDED_DEVICE_EVENTS;
    if (dropped > 0) {
      console.warn(
        `[DEVICE_NOTICE] ${dropped} owed contact line(s) dropped unwritten - more than ${MAX_UNDECIDED_DEVICE_EVENTS} are owed`
      );
    }
    owedLines = kept.slice(-MAX_UNDECIDED_DEVICE_EVENTS);
    return;
  }
  lined = [...lined, line.key].slice(-MAX_ANNOUNCED_DEVICE_KEYS);
}

/**
 * Retries the contact lines still owed - no new evidence is asked, the device was decided new
 * already. One owed past the contact window ({@link CONTACT_NEW_DEVICE_WINDOW_MS}) is dropped: the
 * device is no longer new to anyone reading the conversation.
 */
async function retryOwedLines(
  ctx: DeviceNoticeContext,
  trees: Record<string, Promise<string[]>>
): Promise<void> {
  if (owedLines.length === 0) return;
  for (const line of owedLines) {
    try {
      if (ctx.now() - line.since > CONTACT_NEW_DEVICE_WINDOW_MS) {
        owedLines = owedLines.filter((o) => o.key !== line.key);
        console.log(
          '[DEVICE_NOTICE] an owed contact line expired unwritten - the device is not new now'
        );
        continue;
      }
      settleContactLine(line, await writeContactLines(line.event, line.key, ctx, trees));
    } catch (e) {
      console.error('[DEVICE_NOTICE] one owed contact line not retried:', e);
    }
  }
}

/**
 * Records, in the log and nowhere on screen (owner decision 2026-10-30: no banner), every device of
 * THIS account among `identities` that this device refused for a changed key (`refusedDevices.ts`):
 * such a device is never re-added to anything until its owner resets it. It is an anomaly - a key
 * that changed under a device the account owns - so the line is an error, once per device per
 * session. A contact's refused device is skipped: it is not this account's to reset.
 */
export function noteRefusedOwnDevices(
  identities: string[],
  ctx: Pick<DeviceNoticeContext, 'ownUserId'>
): void {
  const own = canonicalUserId(ctx.ownUserId);
  for (const raw of identities) {
    const identity = canonicalIdentity(raw);
    if (identity === null) continue;
    if (userIdOfLeaf(identity) !== own || refusedLogged.has(identity)) continue;
    refusedLogged.add(identity);
    console.error(
      `[DEVICE_NOTICE] one of this account's devices is refused until it is reset (device ${deviceIdOfLeaf(raw)}): its key changed`
    );
  }
}
