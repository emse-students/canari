import { canari } from '$lib/proto/canari';
import { encodeAppMessage, mkGraineRequest } from '$lib/proto/codec';
import { DELIVERY } from '$lib/mls-client/frameDelivery';
import {
  type DistributionScope,
  scopeLabel,
  workspaceScope,
} from '$lib/mls-client/distributionScope';
import { type ChannelMemberDto, ChannelService } from '$lib/services/ChannelService';
import { whenAnyComesOnline } from '$lib/stores/presenceStore';
import {
  isGraineReady,
  knownHistoryVisibility,
  requireGraineRuntime,
  scopeForChannel,
} from './runtime';
import {
  beginHistoryWidening,
  forgetHistoryClosedSeen,
  noteHistoryClosed,
  settleHistoryWidening,
} from './historyClosedSeen';
import { historyFloorFor, withinHistoryFloor } from './historyBoundary';
import { distributionEpochFor, GraineDistributionUnavailableError } from './seedDistribution';
import { isInEpochGap } from '$lib/utils/chat/epochGapRegistry';
import { canonicalUserId, deviceIdOfLeaf, userIdOfLeaf } from '$lib/mls-client/leafIdentity';
import { describeKeyGroupFrameLosses } from '$lib/mls-client/keyGroupFrameLosses';
import {
  forgetHistoryHeldNothing,
  answeredDevice,
  historyHeldNothingDevices,
  historyHeldNothingFinalAt,
  markHistoryHeldNothingFinal,
  recordHistoryHeldNothing,
} from './historyAnswered';
import {
  forgetPagedHistoryAnswer,
  incompleteHistoryPages,
  noteHistoryAsked,
} from './pagedHistoryAnswer';

/**
 * Asking for a seed this device does not hold (WP-33).
 *
 * A device that was offline when a seed went out, or that joined a salon later, meets messages it
 * cannot open. It knows exactly which session each of them names, so the repair is a lookup and
 * never a replay: it asks for session ids and gets seeds back.
 *
 * Protocol: `docs/wiki/protocols/channel-encryption.md`.
 */

/**
 * Built on first use, never at import.
 *
 * This module is imported by the community-join path, which is itself imported very early; a
 * constructor running at import time makes the whole graph order-sensitive, and the first symptom
 * was a test suite that could no longer load its own mock.
 */
let channelServiceInstance: ChannelService | null = null;
function channels(): ChannelService {
  channelServiceInstance ??= new ChannelService();
  return channelServiceInstance;
}

/**
 * Sessions asked for, and never asked for twice in one app session.
 *
 * A page of fifty unreadable rows names a handful of sessions between them, and the set is what
 * turns that into a handful of requests rather than fifty. Held in MEMORY on purpose: a request is
 * point-to-point transport, so an answerer who was offline never saw it, and the next start must be
 * free to ask again. A durable "already asked" marker would be a state answering a question it was
 * not written for - it would silence the retry exactly when the retry is the whole point.
 *
 * An entry is discharged by an EVENT and never by a clock: the seed arriving
 * ({@link forgetAskedSession}), or the answerer saying it does not hold it
 * ({@link noteSeedUnavailable}).
 */
const asked = new Set<string>();

/**
 * What a still-missing session needs to be asked for AGAIN, kept from the first ask.
 *
 * A re-ask cannot wait for the render to notice the row a second time: the row was dropped when it
 * first failed and nothing re-reads it until the seed lands. So the channel and the minting sender -
 * the two facts {@link resolveAnswerer} needs - are held here for as long as the session is wanted,
 * and dropped the moment it stops being ({@link forgetAskedSession}, or a roster with nobody left).
 */
const wants = new Map<
  string,
  { channelId: string; senderId: string; sentAt: number; reason: AskReason }
>();

/**
 * WHY a session is being asked for, printed on every request line (F3 of the 2026-10-12 queue
 * audit: 185 or more requests in 37 minutes on one key group, against 22 new sessions, and nothing
 * in the log could say why).
 *
 * - `unreadable-row`: a row this app session met names a session this device does not hold. On a
 *   fresh start that includes every session still missing from the last one, since the asked-set is
 *   in memory - the row's age printed beside it separates that from a live miss.
 * - `declined`: the member asked before said it does not hold it; the walk moved on.
 * - `holder-online`: nobody who could answer was online; one of them came back.
 * - `epoch-left`: the previous ask was sealed at an epoch the key group has since left, so nobody
 *   could read it.
 */
export type AskReason = 'unreadable-row' | 'declined' | 'holder-online' | 'epoch-left';

/**
 * Per session, the members who have answered that they do NOT hold it.
 *
 * This is what makes the retry TERMINATE on a proof rather than on a count or a clock: the answerer
 * is picked deterministically from the roster, so without a record of who has declined, the next ask
 * would elect the same member for ever. Each decline removes one member from a finite roster, so the
 * walk ends - either on the seed arriving or on the roster being exhausted, which is said out loud.
 */
const declined = new Map<string, Set<string>>();

/** Missing sessions collected but not yet asked about, keyed by channel. */
const outstanding = new Map<string, Map<string, MissingSeed>>();

/** Who minted a wanted session, and the LATEST message seen naming it. */
interface MissingSeed {
  senderId: string;
  /**
   * Server timestamp of the newest message this device met that names the session, or `Infinity`
   * when no dated row has named it yet.
   *
   * The NEWEST rather than the first, and both sides of the comparison come from the SERVER clock:
   * it is what decides whether the whole session predates our own arrival, and taking the newest
   * means the session is dropped only when EVERY message on it does. `Infinity` for an undated row
   * lands on the same side: a row that cannot place itself against the boundary never suppresses
   * the ask, and the answerer decides.
   */
  sentAt: number;
  /** Why it is asked for now - see {@link AskReason}. */
  reason: AskReason;
}

/** Communities whose history has been asked for in this app session. Same lifetime, same reason. */
const historyAsked = new Set<string>();

/**
 * Communities there was nobody to ask, and the distribution epoch at which that was true.
 *
 * **"Nobody to ask" is a statement about a ROSTER, and a roster has a version.** It used to be
 * recorded in `historyAsked`, which is the set of communities this session has ASKED - so a request
 * that was never sent was filed as one that was, and the skip became permanent for the session. The
 * one thing that clears it is the community leaving the device or a restart, which is the user
 * getting themselves out of an impasse.
 *
 * The cost was not hypothetical. A phone joining a community while the laptop holding its seeds is
 * offline finds no second member and no second device of its own, files the community here, and the
 * laptop then comes online and joins the group - and the phone shows an empty community until it is
 * restarted, with the answerer sitting on the very group it is a member of.
 *
 * Every membership change commits to the distribution group and advances its epoch, and BOTH halves
 * of the condition - another member, another device of ours on the group - are membership. So the
 * epoch is exactly the version of the answer, and comparing it re-asks when the roster moves and
 * only then: a load that changes nothing still costs no request and writes no line.
 */
const historyUnanswerableAt = new Map<string, number>();

/**
 * Per channel, the sessions for which no holder has a device online, each with the members who
 * could answer it once they do - and the waiter that re-asks the moment one of them comes back.
 *
 * **Nobody reachable is an EVENT to wait for, never a delay to sit out.** A request is a transport
 * frame, dropped for a member with no device online, so addressing one anyway is a request nobody
 * ever answers - and until 2026-09-26 that is exactly what happened: on production every request of
 * a member who had just come back to a community went to an offline member, and the salon stayed
 * blank (`docs/wiki/protocols/channel-encryption.md`, WP-33). The want stays in {@link wants}; only
 * the sending waits, and what ends the wait is presence, not a clock.
 */
const parked = new Map<string, { sessions: Map<string, string[]>; cancel: () => void }>();

/** Communities whose history request waits for a member to come online, with that waiter's cancel. */
const historyParked = new Map<string, () => void>();

/**
 * Per community, the history request in flight: what an explicit "I hold nothing" must match before
 * it is recorded as the answer (section 24).
 *
 * The answer is recorded PER DEVICE ({@link recordHistoryHeldNothing}), and a member counts as
 * answered only once every device of theirs on the key group's TREE has said it - presence names the
 * devices online now, and a laptop offline when the phone answered may hold the past. So:
 *
 * - `pending` is the devices the request named that have not answered yet; once it is empty the
 *   walk moves on (the member's offline devices stay unrecorded, and are asked when presence says
 *   they are online). `null` when the request named no device (a roster with no per-device
 *   presence): every device of the member answers, and only `unanswered` can say when all have.
 * - `unanswered` is the member's tree devices not yet recorded; once it is empty the member is
 *   answered. `null` when the tree could not be read: then nothing proves a member answered, so
 *   nothing moves the walk and the ask stays open - one ask at the next start, the cost before.
 *
 * The device an answer names is SELF-ASSERTED on the distribution path (`senderDeviceId`: the user is
 * checked against the MLS credential, the device is not - backlog, "the distribution path's device
 * check"). What bounds a wrong one: only a device the request named, or on the tree when it named
 * none, is counted, and each once.
 */
const historyRequest = new Map<
  string,
  {
    requestId: string;
    answerer: string;
    pending: Set<string> | null;
    unanswered: Set<string> | null;
    groupId: string;
    /** The distribution epoch the request was sealed at, `null` when the group was not ridable. */
    epoch: number | null;
  }
>();

/**
 * The key group each asked session went out on, and the epoch it was sealed at.
 *
 * A REQUEST SEALED AT AN EPOCH THE GROUP LEAVES IS A REQUEST NOBODY CAN READ, and `asked` would
 * still say it is outstanding. On production 2026-09-28 a device at epoch 5 of a key group the
 * server had at 13 asked for its seeds, and every member - all at 13 - dropped the frame. When the
 * group catches up, what went out at an older epoch is asked again: see
 * {@link releaseRequestsHeldForKeyGroup}.
 */
const askedOn = new Map<string, { groupId: string; epoch: number }>();

/**
 * Per session, the id of the request currently outstanding for it AND the member it was addressed to.
 *
 * A decline is durable (it travels as key material), so it can be replayed from the distribution
 * group's log - possibly after the ask it answered was superseded by a newer one for the same
 * session. Counting it against the newer ask would strike a member who was never asked in this walk.
 * The request id is the durable fact that says WHICH ask a decline belongs to; no clock is involved.
 *
 * `named` is the devices of that member the request named (section 23): only one of them may decline
 * for it. `null` when the request named no device (an older social service), and then any device of
 * the member may.
 */
const askedRequest = new Map<
  string,
  { requestId: string; answerer: string; named: ReadonlySet<string> | null }
>();

/**
 * Requests not sent because their key group was behind its epoch, by group, then channel.
 *
 * Held rather than dropped: the wants are real, only the epoch is wrong. Released by the event that
 * ends the gap ({@link releaseRequestsHeldForKeyGroup}), never by a clock.
 */
const heldForKeyGroup = new Map<string, Map<string, Map<string, MissingSeed>>>();

/** Communities whose history request waits for their key group to catch up, by group. */
const historyHeldForKeyGroup = new Map<string, Set<string>>();

/** True while a flush is in flight, so the accumulator keeps filling instead of racing it. */
let flushing = false;

/**
 * Notes that `sessionId` (minted by `senderId`) is missing for `channelId`, and starts a repair.
 *
 * Coalescing comes from the flush's own first network hop - resolving the answerer - during which
 * the rest of the page finishes decoding and lands in the same batch. That is latency doing the
 * work a debounce timer would otherwise do, and unlike a timer it cannot be wrong: the worst case
 * is one extra request, never a silence.
 */
export function noteMissingSeed(
  channelId: string,
  sessionId: string,
  senderId: string,
  sentAt: number | undefined,
  reason: AskReason = 'unreadable-row'
): void {
  if (!sessionId || asked.has(sessionId)) return;
  const perChannel = outstanding.get(channelId) ?? new Map<string, MissingSeed>();
  const sender = senderId.toLowerCase();
  const dated = typeof sentAt === 'number' && Number.isFinite(sentAt) ? sentAt : Infinity;
  const seen = Math.max(dated, perChannel.get(sessionId)?.sentAt ?? 0);
  perChannel.set(sessionId, { senderId: sender, sentAt: seen, reason });
  outstanding.set(channelId, perChannel);
  // Kept for the re-ask: the row that named this session has already been dropped from the render,
  // so nothing would come back to supply the channel, the sender and the date a second time.
  wants.set(sessionId, { channelId, senderId: sender, sentAt: seen, reason });
  if (!flushing) void flushRepairs();
}

/** Drains {@link outstanding}, one request per (channel, answerer). */
async function flushRepairs(): Promise<void> {
  flushing = true;
  try {
    while (outstanding.size > 0) {
      const channelId = [...outstanding.keys()][0];
      // The roster is resolved BEFORE the accumulator is read, so the rest of the page decodes
      // during that hop and lands in this same batch. Reading it first would defeat the point:
      // whatever arrived while the request was in flight would become a second request.
      let targets: RepairTargets;
      try {
        targets = await resolveRepairTargets(channelId);
      } catch (e) {
        outstanding.delete(channelId);
        console.warn(
          `[GRAINE] could not ask for missing seed(s) in channel ${channelId.slice(0, 8)}: ` +
            String(e)
        );
        continue;
      }
      // NOT WHILE THE GROUP'S EPOCH IS STILL BEING ESTABLISHED, and not at all while it is behind:
      // a request is sealed at this device's epoch, and one sealed at an epoch every member has left
      // is read by nobody. Awaited BEFORE the accumulator is read, for the coalescing reason above.
      await requireGraineRuntime(
        'cannot ask for a missing seed'
      ).mlsService.whenDistributionEpochSettled(targets.groupId);
      const sessions = outstanding.get(channelId) ?? new Map<string, MissingSeed>();
      outstanding.delete(channelId);
      if (isInEpochGap(targets.groupId)) {
        holdForKeyGroup(targets.groupId, channelId, sessions);
        continue;
      }
      try {
        await requestSeedsForChannel(channelId, sessions, targets);
      } catch (e) {
        // Best-effort, and therefore said out loud: the only other symptom is a salon whose older
        // messages stay unreadable with nothing anywhere naming the reason.
        console.warn(
          `[GRAINE] could not ask for ${sessions.size} missing seed(s) in channel ${channelId.slice(0, 8)}: ` +
            String(e)
        );
      }
    }
  } finally {
    flushing = false;
  }
}

/** Everything a request needs that is not the sessions themselves. */
interface RepairTargets {
  workspaceId: string;
  groupId: string;
  /** Who is in the community, lower-cased - the population an answerer is chosen from. */
  roster: Set<string>;
  /** Of {@link roster}, who has a device online right now - the only members a request reaches. */
  online: Set<string>;
  /** Whether another device of OURS sits on the group - see {@link ownDevicesOnTheGroup}. */
  ownOtherDevices: boolean;
  /**
   * Per member, the devices that can answer a request on this group right now - see
   * {@link answeringDevicesOn}. `null` when that could not be told, and then no device is named.
   */
  answering: Map<string, string[]> | null;
}

/** Resolves the community, the group carrying the salon's seeds, and the roster to ask. */
async function resolveRepairTargets(channelId: string): Promise<RepairTargets> {
  const { mlsService } = requireGraineRuntime('cannot ask for a missing seed');
  const scope = scopeForChannel(channelId);
  if (!scope) throw new Error(`channel ${channelId} belongs to no loaded community`);
  const workspaceId = scope.workspaceId;
  const groupId = mlsService.distributionGroupFor(scope);
  if (!groupId) throw new GraineDistributionUnavailableError(scope, 'key-group-unregistered');

  // THE ROSTER TO ASK IS THE ROSTER THAT HOLDS THE SEED. On a private salon that is the salon's own
  // members, and asking the community's would name an answerer who cannot even see the request -
  // it travels on the salon's group, which they are not in.
  const memberScope = scope.kind === 'channel' ? 'channel' : 'workspace';
  const label = `channel ${channelId.slice(0, 8)}`;
  const { roster, online, devices } = electionRoster(
    await channels().listMembers(channelId, memberScope, { presence: true }),
    label
  );
  const answering = await answeringDevicesOn(groupId, devices, label);
  return {
    workspaceId,
    groupId,
    roster,
    online: answering ? reachableThroughDevices(online, answering) : online,
    ownOtherDevices: await ownDevicesOnTheGroup(scope),
    answering,
  };
}

/**
 * Per member, the devices that can ANSWER a request on `groupId` right now: online (the roster's
 * per-device presence) AND a leaf of this device's own copy of the group's tree - sorted, this
 * device excluded, members with none omitted.
 *
 * **Both halves are needed, and each is a fact already held.** A request is transport, so only a
 * device with a socket open receives it; and it is an MLS frame on this group, so only a leaf can
 * read it. The roster's presence alone cannot say whether that device ever joined this key group,
 * and the tree is the only authority on who can read a group (`getGroupMemberIdentities`).
 *
 * `null` - "could not tell", so no device is named and every device of the member answers, as before
 * 1.2.5 - when the social service predates `onlineDevices`, or the tree cannot be read. Each says so:
 * the first is version skew, the second a group this device does not hold.
 */
async function answeringDevicesOn(
  groupId: string,
  onlineDevices: Map<string, string[]> | null,
  label: string
): Promise<Map<string, string[]> | null> {
  return answeringDevicesIn(
    onlineDevices ? await treeDevicesOn(groupId) : null,
    onlineDevices,
    label
  );
}

/** {@link answeringDevicesOn} over a tree already read ({@link treeDevicesOn}). */
function answeringDevicesIn(
  tree: TreeDevices | null,
  onlineDevices: Map<string, string[]> | null,
  label: string
): Map<string, string[]> | null {
  if (!onlineDevices) {
    console.warn(
      `[GRAINE] the roster of ${label} came back without per-device presence - naming no answering ` +
        `device, so every device of the member asked will answer; the social service predates 1.2.5`
    );
    return null;
  }
  if (!tree) {
    console.warn(`[GRAINE] no tree of ${label}'s key group - naming no answering device`);
    return null;
  }
  const answering = new Map<string, string[]>();
  for (const [userId, devices] of onlineDevices) {
    const usable = devices.filter((d) => tree.get(userId)?.has(d) === true).sort();
    if (usable.length > 0) answering.set(userId, usable);
  }
  return answering;
}

/**
 * Per member (lower-cased), the device ids of theirs that are leaves of a key group. A member with a
 * leaf that names no device has an EMPTY set; a member with no leaf at all has no entry.
 */
type TreeDevices = Map<string, Set<string>>;

/**
 * Every device of every member on `groupId`'s MLS tree as this device holds it, THIS device
 * excluded - the authority on who can read the group, and so on who can still hold its past
 * whatever presence says. `null` when the tree cannot be read (a group this device does not hold),
 * said at warn.
 */
async function treeDevicesOn(groupId: string): Promise<TreeDevices | null> {
  const { mlsService } = requireGraineRuntime('cannot read a key group tree');
  let leaves: string[];
  try {
    leaves = await mlsService.getGroupMemberIdentities(groupId);
  } catch (e) {
    console.warn(
      `[GRAINE] cannot read the tree of key group ${groupId.slice(0, 8)}... (${String(e)})`
    );
    return null;
  }
  const me = mlsService.getDeviceId();
  const tree: TreeDevices = new Map();
  for (const leaf of leaves) {
    const device = deviceIdOfLeaf(leaf);
    if (device === me) continue;
    const user = userIdOfLeaf(leaf);
    const devices = tree.get(user) ?? new Set<string>();
    // A leaf naming no device still puts its member ON the tree - with no device that could ever
    // answer, so never `exhausted` - and keeps them from reading as a member with no leaf at all
    // (`heldNothingView`'s `leafless`), which is a claim that they hold nothing of the group.
    if (device !== '') devices.add(device);
    tree.set(user, devices);
  }
  return tree;
}

/**
 * Of the members the roster calls online, the ones with a device that can answer on this group.
 *
 * A member online on a device that is not a leaf of this key group cannot read a request sent on
 * it, so electing them is the silent answerer WP-33 exists to avoid, one step further down.
 */
function reachableThroughDevices(
  online: ReadonlySet<string>,
  answering: ReadonlyMap<string, string[]>
): Set<string> {
  return new Set([...online].filter((userId) => answering.has(userId)));
}

/**
 * A bound on the size of a request's device list, nothing more. The request itself is transport to
 * the whole key group, never an addressed frame, so this is not the delivery service's
 * `MAX_ADDRESSED_DEVICES`. A member with more devices online than this is an anomaly.
 */
const MAX_NAMED_ANSWERERS = 16;

/**
 * EVERY device of `answerer` that can answer, sorted and capped at {@link MAX_NAMED_ANSWERERS}, or
 * `[]` (every device of theirs answers) when none can be named.
 *
 * **All of them, never one** (review of #1768): naming the lowest id named a backgrounded phone whose
 * socket stays open and whose script does not run (`tauri-` sorts before `web-`), and a silent named
 * device is a walk that never moves. Naming every device costs one addressed answer per device - to
 * the requesting device only. The first decline from a named device strikes the member
 * ({@link noteSeedUnavailable}).
 */
function answeringDevicesOf(answerer: string, answering: Map<string, string[]> | null): string[] {
  return (answering?.get(answerer.toLowerCase()) ?? []).slice(0, MAX_NAMED_ANSWERERS);
}

/**
 * The "I hold nothing" record read against the key group's tree and presence (section 24): which
 * members a history ask may skip, and whether every device that could hold the past has answered.
 *
 * - `exhausted(id)`: every device of `id` on the TREE answered. `false` when the tree is unknown or
 *   holds no device of theirs - nothing is proven answered from a fact this device does not have.
 * - `leafless(id)`: the tree is KNOWN and holds no leaf of `id` at all - a roster member who never
 *   signed in, or whose devices never joined the key group. Such a member can hold nothing sealed to
 *   this group, so they are skipped, never waited on, and count as answered for the final check.
 *   An unknown tree proves nothing about them either way: `false`, today's reading.
 * - `spent(id)`: every device of `id` ONLINE answered, and at least one is online. Skipped for now,
 *   never recorded as answered: its other devices on the tree are offline and may hold the past.
 */
function heldNothingView(
  roster: ReadonlySet<string>,
  tree: TreeDevices | null,
  recorded: ReadonlySet<string>,
  answering: Map<string, string[]> | null
) {
  const unansweredOf = (id: string, devices: Iterable<string>) =>
    [...devices].filter((d) => !recorded.has(answeredDevice(id, d)));
  const exhausted = (id: string): boolean => {
    const devices = tree?.get(id);
    return devices !== undefined && devices.size > 0 && unansweredOf(id, devices).length === 0;
  };
  const unansweredOnline = (id: string): string[] =>
    unansweredOf(id, answering?.get(id.toLowerCase()) ?? []).slice(0, MAX_NAMED_ANSWERERS);
  const leafless = (id: string): boolean => tree !== null && !tree.has(id);
  const done = (id: string): boolean => exhausted(id) || leafless(id);
  const spent = (id: string): boolean =>
    answering !== null &&
    (answering.get(id) ?? []).length > 0 &&
    unansweredOf(id, answering.get(id) ?? []).length === 0;
  return {
    exhausted,
    /** Nothing left to hear from `id` at this tree: every tree device answered, or there is none. */
    done,
    unansweredOnline,
    /** The tree devices of `id` not yet recorded, or `null` when the tree is unknown. */
    unansweredOnTree: (id: string): Set<string> | null =>
      tree ? new Set(unansweredOf(id, tree.get(canonicalUserId(id)) ?? [])) : null,
    /** The members the election skips: answered from every device, or from every one online. */
    skipped: new Set([...roster].filter((id) => done(id) || spent(id))),
    /** Every other member done, and our own other devices on the tree too, if any. */
    everyDeviceAnswered: (self: string): boolean =>
      tree !== null &&
      [...roster].filter((id) => id !== self).every(done) &&
      ((tree.get(self)?.size ?? 0) === 0 || exhausted(self)),
  };
}

/** How a request's named devices read in a log line. */
function describeNamedDevices(devices: readonly string[]): string {
  return devices.length > 0 ? devices.join(',') : 'every device';
}

/**
 * A roster read with presence, as the election consumes it: who is in it, and who of them has a
 * device online.
 *
 * **Presence is carried TO the decision** rather than learnt by failing: the server reads the
 * gateway's liveness keys when it answers the roster, so the device electing an answerer knows
 * whether the frame it is about to send can reach them.
 *
 * A row WITHOUT the flag is a server that did not answer the question - never "offline". It is
 * elected as if online, because this is a bandwidth decision and parking a want on a missing field
 * would strand it; and it is said at warn level, because reaching it means the server half of the
 * contract is not deployed where this client runs.
 */
function electionRoster(
  rows: ChannelMemberDto[],
  label: string
): {
  roster: Set<string>;
  online: Set<string>;
  /** Per member, the devices online; `null` when any row came back without them (older server). */
  devices: Map<string, string[]> | null;
} {
  const roster = new Set<string>();
  const online = new Set<string>();
  let devices: Map<string, string[]> | null = new Map();
  let unanswered = 0;
  for (const row of rows) {
    const id = String(row.userId).toLowerCase();
    roster.add(id);
    if (typeof row.online !== 'boolean') unanswered++;
    if (row.online !== false) online.add(id);
    if (!Array.isArray(row.onlineDevices)) devices = null;
    else if (devices && row.onlineDevices.length > 0) devices.set(id, [...row.onlineDevices]);
  }
  if (unanswered > 0) {
    console.warn(
      `[GRAINE] the roster of ${label} came back without presence for ${unanswered} member(s) - ` +
        `electing them as if online; the social service answering it predates the presence field`
    );
  }
  return { roster, online, devices };
}

/**
 * Whether another DEVICE of ours sits on this scope's distribution group.
 *
 * THE ONE FACT THAT MAKES US A CANDIDATE ANSWERER, and the reason a request addressed to our own
 * user id is not the round trip that answers nothing {@link resolveAnswerer} used to call it. A
 * request names a USER (`frameHandler` compares `answererUserId` against the reader's user id, never
 * against a device), and MLS never hands a sender its own message back - so a request we address to
 * ourselves reaches every OTHER device of ours and only them. When the seed was minted by one of
 * them, that is the surest holder in the whole roster.
 *
 * Measured on production 2026-08-25 (COMM-18): a phone that cold-started into a community whose only
 * member was its own user met one unreadable message, asked nobody, and stayed blank for ever -
 * `no other member to ask for history`, then `no reachable holder`, while the laptop that had
 * minted the seed sat online in the same group.
 *
 * **The server is the only authority, and it answers exactly this question.** `memberDevices` is
 * which of THIS user's devices the group holds a membership row for; a client knows only that it
 * once joined. Delivery rows are not MLS leaves, so a row can outlive the ability to answer - which
 * is why this decides whether to ASK and never what to conclude from silence.
 *
 * **Fail-OPEN, like {@link withheldFromUs} and for the same reason:** this is a bandwidth decision,
 * not an entitlement one. A wasted frame costs one transport message; refusing to ask because a read
 * failed costs a message nobody can ever open. Every branch says which it took.
 */
async function ownDevicesOnTheGroup(scope: DistributionScope): Promise<boolean> {
  const { mlsService } = requireGraineRuntime('cannot tell our own devices apart');
  let devices: string[] | undefined;
  try {
    devices = (await channels().getDistributionGroup(scope)).memberDevices;
  } catch (e) {
    console.warn(
      `[GRAINE] could not read our own devices on the distribution group of ${scopeLabel(scope)} ` +
        `(${String(e)}) - asking ourselves anyway rather than ` +
        `stranding a seed`
    );
    return true;
  }
  if (!Array.isArray(devices)) {
    // An older delivery service, or a read that did not name the reader. `undefined` is "the
    // question was never put", never "no devices" - so it may not be read as a negative answer.
    console.info(
      `[GRAINE] the server named no devices of ours on the distribution group of ${scopeLabel(scope)} - ` +
        `treating our other devices as reachable`
    );
    return true;
  }
  return devices.some((deviceId) => deviceId !== mlsService.getDeviceId());
}

/** Sends one request per answerer for `sessions` of `channelId`. */
async function requestSeedsForChannel(
  channelId: string,
  sessions: Map<string, MissingSeed>,
  { workspaceId, groupId, roster, online, ownOtherDevices, answering }: RepairTargets
): Promise<void> {
  const { mlsService, userId } = requireGraineRuntime('cannot ask for a missing seed');

  // WHAT WE MAY NOT BE GIVEN, WE DO NOT ASK FOR. The community's rule was broadcast to this device
  // and our own arrival is one roster fetch away, so a request for a session whose every message
  // predates us is a frame the whole group decrypts to learn what we already knew - and the answer
  // is silence, so it would be re-sent at every start. The answerer applies the same rule, which is
  // where the rule is ENFORCED; this is only what stops us wasting the group's bandwidth on it.
  const beyondReach = await withheldFromUs(workspaceId, userId, sessions);
  for (const sessionId of beyondReach) {
    sessions.delete(sessionId);
    wants.delete(sessionId);
    askedRequest.delete(sessionId);
    declined.delete(sessionId);
  }
  if (beyondReach.length > 0) {
    console.info(
      `[GRAINE] not asking for ${beyondReach.length} seed(s) of channel ${channelId.slice(0, 8)}: ` +
        `community ${workspaceId.slice(0, 8)} is set to 'joined' and they predate our arrival`
    );
  }

  // ONE named answerer per request, never a broadcast: every member holding the seed would
  // otherwise answer at once, so a salon of three hundred would pay three hundred bundles for one
  // missing session.
  const byAnswerer = new Map<string, string[]>();
  const waiting = new Map<string, string[]>();
  for (const [sessionId, { senderId }] of sessions) {
    const election = resolveAnswerer(
      senderId,
      roster,
      online,
      userId,
      declined.get(sessionId),
      ownOtherDevices
    );
    if (election.kind === 'wait') {
      waiting.set(sessionId, election.offline);
      continue;
    }
    if (election.kind === 'exhausted') {
      // The roster is exhausted: everyone who could have held it has been asked and has said no.
      // That is the walk TERMINATING on a proof, so the want is dropped rather than left to be
      // retried for ever - and it is said once, here, rather than discovered as a permanently blank
      // message every time the salon is opened.
      console.warn(
        `[GRAINE] session ${sessionId} of channel ${channelId.slice(0, 8)} has no reachable holder - ` +
          `its sender ${senderId} is gone or does not hold it, and every other member has declined` +
          // WHICH EXHAUSTION THIS IS. "Nobody left to ask" and "we have no second device and the
          // community has no second member" are different situations with the same silence, and only
          // the first is the walk terminating on a proof.
          (ownOtherDevices ? ', our own other device(s) included' : ' (we have no other device)')
      );
      wants.delete(sessionId);
      askedRequest.delete(sessionId);
      declined.delete(sessionId);
      continue;
    }
    const { answerer } = election;
    byAnswerer.set(answerer, [...(byAnswerer.get(answerer) ?? []), sessionId]);
  }
  if (waiting.size > 0) parkUntilOnline(channelId, waiting);

  for (const [answerer, sessionIds] of byAnswerer) {
    const requestId = crypto.randomUUID();
    // The member's devices that can read this group, each answering to our device alone (section 23).
    const answererDevices = answeringDevicesOf(answerer, answering);
    const frame = encodeAppMessage(
      mkGraineRequest({
        workspaceId,
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
        sessionIds,
        answererUserId: answerer,
        answererDeviceIds: answererDevices,
        requestId,
      })
    );
    // Recorded BEFORE the send: the answer may land before `sendMessage` resolves.
    const named = answererDevices.length > 0 ? new Set(answererDevices) : null;
    sessionIds.forEach((id) =>
      askedRequest.set(id, { requestId, answerer: answerer.toLowerCase(), named })
    );
    // Transport, never durable: a request restates state held elsewhere, so replaying it from the
    // shared log would be circular - and that log is capped per group, so writing requests into it
    // would evict the seeds it exists to carry.
    await mlsService.sendMessage(groupId, frame, undefined, DELIVERY.transport);
    const sealedAt = mlsService.getEpoch(groupId);
    sessionIds.forEach((id) => {
      asked.add(id);
      askedOn.set(id, { groupId, epoch: sealedAt });
    });
    console.info(
      `[GRAINE] asked ${answerer} (${describeNamedDevices(answererDevices)}) for ${sessionIds.length} ` +
        `seed(s) in community ${workspaceId.slice(0, 8)} at epoch ${sealedAt} - ` +
        describeAskReasons(sessionIds, sessions, groupId)
    );
  }
}

/**
 * WHY these sessions are asked for, as one log fragment (F3 of the 2026-10-12 queue audit): the
 * reasons tallied, how old the newest row naming them is, and what this device lost on the key group
 * this session. Read together they separate the candidate causes of a request: a seed frame lost on
 * arrival (losses beside a young row), a session missing since before this start (an old row, no
 * losses), or a walk down the roster (`declined`, `epoch-left`).
 */
function describeAskReasons(
  sessionIds: readonly string[],
  sessions: ReadonlyMap<string, MissingSeed>,
  groupId: string
): string {
  const tally = new Map<AskReason, number>();
  const ages: number[] = [];
  const now = Date.now();
  for (const id of sessionIds) {
    const seed = sessions.get(id);
    if (!seed) continue;
    tally.set(seed.reason, (tally.get(seed.reason) ?? 0) + 1);
    if (Number.isFinite(seed.sentAt)) ages.push(Math.max(0, now - seed.sentAt));
  }
  const reasons = [...tally]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, n]) => `${reason}=${n}`)
    .join(' ');
  const rowAge =
    ages.length === 0
      ? 'undated'
      : `${formatAge(Math.min(...ages))}..${formatAge(Math.max(...ages))}`;
  return `reasons ${reasons || 'none'}, newest row ${rowAge} old, key group lost ${describeKeyGroupFrameLosses(groupId)} this session`;
}

/** A duration as the one coarse unit a log reader needs: seconds, minutes, hours or days. */
function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)}min`;
  if (s < 172_800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/**
 * Of the sessions wanted, the ones the community's history rule puts out of OUR reach.
 *
 * Under `shared` there is no boundary and this is always empty; under `joined` it is every session
 * whose newest known message still predates our own arrival. Rotation makes that test exact rather
 * than approximate: a join advances the distribution group's epoch and every sender rotates on the
 * next send, so no session spans an arrival and one whose latest message is older than ours was
 * minted entirely before we were there.
 *
 * **Fail-OPEN, unlike its counterpart on the answering side, and deliberately so.** This is a
 * bandwidth decision, not the enforcement: the answerer places the boundary itself and refuses what
 * we may not have. Refusing to ask because our own roster fetch failed would strand seeds we are
 * entitled to, for a saving of one frame.
 */
async function withheldFromUs(
  workspaceId: string,
  userId: string,
  sessions: Map<string, MissingSeed>
): Promise<string[]> {
  let floor: number | null;
  try {
    floor = await historyFloorFor(workspaceId, userId);
  } catch (e) {
    console.warn(
      `[GRAINE] asking for seed(s) of community ${workspaceId.slice(0, 8)} without placing our own ` +
        `history boundary: ` +
        String(e)
    );
    return [];
  }
  if (floor === null) return [];

  const bound = floor;
  return [...sessions]
    .filter(([, seed]) => !withinHistoryFloor(bound, seed.sentAt))
    .map(([sessionId]) => sessionId);
}

/** What the election decided for one session. */
export type Election =
  /** Send the request to this member. */
  | { kind: 'ask'; answerer: string }
  /**
   * Nobody who could answer has a device online. `offline` is who could, once back - the want is
   * parked on their presence ({@link parkUntilOnline}).
   */
  | { kind: 'wait'; offline: string[] }
  /** Everyone who could have held it has declined: the walk has terminated on a proof. */
  | { kind: 'exhausted' };

/**
 * Who to address a request to: the session's own sender, or the lowest user id still in the
 * community that has not already declined - AMONG THE MEMBERS WITH A DEVICE ONLINE.
 *
 * **Only a member who can receive the frame is a candidate.** A request is transport, dropped for a
 * member with no device online, so electing one is a request nobody answers - and nothing ever
 * replaces a SILENT answerer, only one that declines. On production 2026-09-24 a member back in an
 * 8-member community asked the lowest id (offline two days) for its history and each author (two
 * of them offline for weeks) for their sessions, while several online members held every seed; the
 * salon stayed blank. The order is unchanged and still total over what every device sees; it is
 * taken over the reachable members, and when there are none the answer is to WAIT, not to guess.
 *
 * The sender always holds the seed, so they are the answer whenever they are still reachable. When
 * they are not, SOME member has to be picked and every device has to pick the same one without
 * talking to any other - so it is the lowest id, which is a total order every device already has.
 * No clock, no election, nothing for a race to decide.
 *
 * **OURSELVES, BUT ONLY WITH ANOTHER DEVICE TO REACH.** The sender of a session is very often this
 * very user - another device of theirs minted it - and this used to exclude them by name, on the
 * reasoning that "a request addressed to us reaches only us, who are asking precisely because we do
 * not hold it". That reads a USER as a DEVICE. A request names a user id, `frameHandler` matches it
 * against the reader's user id, and MLS never hands a sender its own message back: addressed to
 * ourselves it reaches our OTHER devices and nobody else. The exclusion therefore skipped the one
 * holder it could name with certainty, and a person whose community has no second MEMBER had no
 * candidate at all - measured on production 2026-08-25, a phone left permanently unable to read a
 * message its owner's laptop had just sent (COMM-18).
 *
 * So we are a candidate exactly when {@link ownDevicesOnTheGroup} says there is another device of
 * ours to reach - FIRST when one of them minted the session, LAST otherwise, because a device that
 * merely happened to be online is a weaker guess than any named member.
 *
 * **Never someone who has said no.** Determinism is what makes the choice safe and is also what
 * would make it a dead end: a member elected by the rule but holding nothing would be elected again
 * on every retry. `tried` is what turns one election into a walk down the roster, and because the
 * roster is finite the walk ends - on the seed, or on `null`, which the caller reports.
 *
 * @param senderId Who minted the session; the first candidate whenever they are still a member.
 * @param roster Community members, lower-cased.
 * @param online Of `roster`, who has a device online - the only other members a request reaches.
 * @param self This user - a candidate only through another device, see above.
 * @param tried Members who have already answered that they do not hold it.
 * @param ownOtherDevices Whether another device of ours is on the group to receive the request.
 */
export function resolveAnswerer(
  senderId: string,
  roster: Set<string>,
  online: ReadonlySet<string>,
  self: string,
  tried?: ReadonlySet<string>,
  ownOtherDevices = false
): Election {
  const sender = senderId.toLowerCase();
  const me = self.toLowerCase();
  const untried = (id: string) => !tried?.has(id);
  // Our own presence says nothing about our OTHER devices - this one is online by definition - so
  // for us the server's device rows decide, exactly as before.
  const reachable = (id: string) => untried(id) && (id === me ? ownOtherDevices : online.has(id));
  if (roster.has(sender) && reachable(sender)) return { kind: 'ask', answerer: sender };
  const other = lowestOtherMember(roster, me, tried, online);
  if (other) return { kind: 'ask', answerer: other };
  // Every online member is exhausted. One of our own devices may still have been online when the
  // seed went out, and asking is the difference between one frame and a message nobody can open.
  if (reachable(me)) return { kind: 'ask', answerer: me };
  const offline = [...roster].filter((id) => id !== me && untried(id)).sort();
  return offline.length > 0 ? { kind: 'wait', offline } : { kind: 'exhausted' };
}

/**
 * The lowest user id in the roster that is neither us nor already tried and has a device online,
 * or null when there is nobody such.
 */
function lowestOtherMember(
  roster: Set<string>,
  self: string,
  tried: ReadonlySet<string> | undefined,
  online: ReadonlySet<string>
): string | null {
  return (
    [...roster].filter((id) => id !== self && !tried?.has(id) && online.has(id)).sort()[0] ?? null
  );
}

/**
 * Holds `sessions` of `channelId` until one of the members who could answer them comes online,
 * then asks again - through {@link noteMissingSeed}, so the re-ask is an ordinary election over a
 * fresh roster rather than a replay of a stale one.
 *
 * Merged per channel: a later batch finding nobody either joins the one already waiting rather than
 * stacking a second waiter over the same people.
 *
 * @param sessions Session id -> the members (lower-cased) who could answer it once online.
 */
function parkUntilOnline(channelId: string, sessions: Map<string, string[]>): void {
  const previous = parked.get(channelId);
  previous?.cancel();
  const merged = new Map([...(previous?.sessions ?? []), ...sessions]);
  const candidates = [...new Set([...merged.values()].flat())];
  console.info(
    `[GRAINE] ${merged.size} seed(s) of channel ${channelId.slice(0, 8)} wait for a holder to come ` +
      `online - ${candidates.length} member(s) could answer and none has a device online`
  );
  const cancel = whenAnyComesOnline(candidates, (back) => {
    parked.delete(channelId);
    const stillWanted = [...merged.keys()].filter((sessionId) => wants.has(sessionId));
    if (stillWanted.length === 0) return;
    console.info(
      `[GRAINE] ${back.length} member(s) came online - asking again for ${stillWanted.length} ` +
        `seed(s) of channel ${channelId.slice(0, 8)}`
    );
    for (const sessionId of stillWanted) {
      const want = wants.get(sessionId);
      if (want)
        noteMissingSeed(want.channelId, sessionId, want.senderId, want.sentAt, 'holder-online');
    }
  });
  parked.set(channelId, { sessions: merged, cancel });
}

/**
 * Whether this device owes `workspaceId` a WIDENED history ask: its past was closed (`joined`) when
 * this device last heard, and the server now says `shared` ({@link beginHistoryWidening}).
 *
 * Also where a closed past is RECORDED, because every start passes through here for every community
 * (`ensureCommunityDistributionGroup`) - so a member who learns `joined` from a listing is recorded
 * without a second hook. Only a rule the server STATED counts (`knownHistoryVisibility`): the
 * fail-closed `joined` of a rule never learned would record a closed past that never was.
 *
 * @returns `first` on the first sight of a widening, `continuing` while it is unanswered, `none`
 *   otherwise - and `none` with no session wired, which the caller then refuses on its own.
 */
function historyWidening(workspaceId: string): 'first' | 'continuing' | 'none' {
  if (!isGraineReady()) return 'none';
  const { userId } = requireGraineRuntime('cannot read the community history rule');
  const rule = knownHistoryVisibility(workspaceId);
  if (rule === 'joined') {
    noteHistoryClosed(userId, workspaceId);
    return 'none';
  }
  if (rule !== 'shared') return 'none';
  const widening = beginHistoryWidening(userId, workspaceId);
  if (widening === 'first') {
    console.info(
      `[GRAINE] community ${workspaceId.slice(0, 8)} now shares its past, which was closed to this ` +
        `device - asking for it again`
    );
  }
  return widening;
}

/** Drops a widening that has its answer, saying why - and nothing when there was none. */
function settleWidening(userId: string, workspaceId: string, why: string): void {
  if (settleHistoryWidening(userId, workspaceId)) {
    console.info(
      `[GRAINE] the widened history ask of community ${workspaceId.slice(0, 8)} is settled: ${why}`
    );
  }
}

/**
 * A bundle CARRYING SEEDS answered `requestId` in `workspaceId`: if that is the history ask in
 * flight, a widened ask has its answer and is not asked again (the seeds themselves are stored by
 * the frame handler, whatever this says). Any other request id is not this ask's answer.
 */
export function noteHistoryAnswered(workspaceId: string, requestId: string): void {
  const inFlight = historyRequest.get(workspaceId);
  if (!inFlight || inFlight.requestId !== requestId || !isGraineReady()) return;
  settleWidening(
    requireGraineRuntime('cannot record a history answer').userId,
    workspaceId,
    `${inFlight.answerer} answered with seeds`
  );
}

/**
 * Asks the community for the history a joiner is entitled to, once per session and only when this
 * device holds nothing.
 *
 * **Both halves of the condition are derived state, not a flag.** "I hold no seed for this
 * community" is read from the store, so it stays true across a reload a "done" marker would have
 * lied about; "I have not asked yet" is in memory, so a restart is free to ask again - the answerer
 * may simply have been offline. Neither is a clock.
 *
 * **A THIRD OUTCOME IS NEITHER OF THOSE: there was nobody to ask.** No request went out, so nothing
 * is outstanding, and filing it as "asked" is recording something that did not happen. It is keyed
 * on the distribution epoch instead - see {@link historyUnanswerableAt} - so the next ordinary
 * trigger re-asks once the roster has moved, and costs nothing while it has not.
 *
 * **A FOURTH IS AN ANSWER: "I hold nothing"** (section 24). Unlike the in-memory "asked", it is
 * durable, keyed on the same roster version, so a community whose answerer holds nothing is asked
 * ONCE per roster rather than once per launch - see {@link noteHistoryHeldNothing}.
 *
 * **Asked under BOTH rules** (2026-10-22). Under `joined` the answerer hands over what the member
 * may read, floored at the member's arrival, or says it has nothing for them - so the ask is
 * answered either way and recorded like any other, where it used to be refused by silence at every
 * launch. And **a past that WIDENED is asked for again even though seeds are held**
 * ({@link historyWidening}): a member who arrived under `joined` holds only what was floored for
 * them, and a switch to `shared` would otherwise never reach them.
 *
 * Best-effort by construction: it is called from the join path and must never fail it. Every branch
 * says what it did, because the alternative symptom is a joiner staring at an empty salon.
 */
export async function requestCommunityHistory(
  workspaceId: string,
  /**
   * Ask even though this device holds seeds for the community. Only after a key group was RE-JOINED:
   * the frames of the epochs it skipped were acknowledged unreadable, so what it holds is no longer
   * evidence that it holds the past.
   */
  { evenIfSeedsHeld = false }: { evenIfSeedsHeld?: boolean } = {}
): Promise<void> {
  // A WIDENED PAST IS ASKED FOR AGAIN TOO, whatever is held (see {@link historyWidening}): what
  // this device holds was handed over floored at its member's arrival, so it is no evidence that it
  // holds the past it may now read. The FIRST sight of the widening re-arms the ask even if this
  // session already asked (under the floor); later passes follow the ordinary once-per-session rule.
  const widening = historyWidening(workspaceId);
  if (historyAsked.has(workspaceId) && !evenIfSeedsHeld && widening !== 'first') return;
  const { storage, deviceKey, userId, mlsService } = requireGraineRuntime(
    'cannot ask for community history'
  );
  if (evenIfSeedsHeld || widening === 'first') {
    historyAsked.delete(workspaceId);
    // A RE-JOINED key group skipped epochs it acknowledged unreadable: an earlier "I hold nothing"
    // is no more evidence about the past than the seeds this device holds (section 24). Nor is one
    // given while the past was closed: it said "nothing here FOR YOU", under the floor. Forgotten
    // ONCE per widening - the walk re-enters here after each answer. The in-memory "nobody could
    // answer at this epoch" goes with it, for the same reason: it was reached under the floor, and
    // a widening that arrives live (`workspace.updated`) does not move the epoch.
    forgetHistoryHeldNothing(userId, workspaceId);
    historyUnanswerableAt.delete(workspaceId);
  }

  // HOLDING SOME SEEDS IS NOT HOLDING THE PAST - a member back in a community holds exactly the
  // seeds sent since the return. That past is not this request's to fetch: every row this device
  // cannot open names its session and asks for it ({@link noteMissingSeed}), which is what derives
  // what is missing from the messages themselves. On 2026-09-24 that path failed too, only because
  // it addressed offline members; it elects among the online ones now. Asking the whole bundle again
  // here at every start, of one member, for seeds this device mostly holds, would buy nothing that
  // path does not already deliver session by session.
  const held = await storage.getGraineSessionsForWorkspace(workspaceId, deviceKey());
  // A WIDENING (above) IS ONE EXCEPTION. AN ANSWER THAT ARRIVED IN PART IS THE OTHER (section 4.4): its first page is what made
  // `held` non-empty, so without this a page lost after it is never asked for as a whole - only
  // session by session, as rows under it fail to open and stay hidden until each repair lands. Asked
  // ONCE more, at a start after the loss; `pagedHistoryAnswer` spends that once only when it is sent.
  const missingPages = held.length > 0 ? incompleteHistoryPages(userId, workspaceId) : null;
  if (held.length > 0 && !evenIfSeedsHeld && widening === 'none' && !missingPages) return;
  if (missingPages && !evenIfSeedsHeld) {
    console.info(
      `[GRAINE] the history answer of community ${workspaceId.slice(0, 8)} arrived incomplete - ` +
        `page(s) ${missingPages.map((i) => i + 1).join(', ')} never came; asking once more`
    );
  }

  const scope = workspaceScope(workspaceId);
  const groupId = mlsService.distributionGroupFor(scope);
  if (!groupId) throw new GraineDistributionUnavailableError(scope, 'key-group-unregistered');

  // The same rule as a seed request, for the same reason: see {@link askedOn}.
  await mlsService.whenDistributionEpochSettled(groupId);
  if (isInEpochGap(groupId)) {
    const waiting = historyHeldForKeyGroup.get(groupId) ?? new Set<string>();
    waiting.add(workspaceId);
    historyHeldForKeyGroup.set(groupId, waiting);
    console.info(
      `[GRAINE] the history of community ${workspaceId.slice(0, 8)} waits for its key group ${groupId.slice(0, 8)}... to catch up - a request sealed now would be read by nobody`
    );
    return;
  }

  // Before the roster read below, which is a network call: a pass that finds the same epoch is a
  // pass asking the same question of the same people, and it already has the answer. `null` is not
  // an epoch and never matches one - a group this device cannot ride yet is not evidence about who
  // is on it.
  const epoch = distributionEpochFor(mlsService, scope);
  if (epoch !== null && historyUnanswerableAt.get(workspaceId) === epoch) return;
  // ASKED AND ANSWERED, durably (section 24): EVERY member of this very roster was asked in turn and
  // said it holds nothing of the community. Asking again would put the same question to the same
  // people - which is what every launch did while that answer was a silence. Short of final, the
  // members who answered are skipped by the election below and the next one is asked.
  const version = epoch === null ? null : { groupId, epoch };
  if (version && historyHeldNothingFinalAt(userId, workspaceId, version)) {
    console.debug(
      `[GRAINE] the history of community ${workspaceId.slice(0, 8)} is not asked: every member was ` +
        `answered "I hold nothing" at distribution epoch ${epoch}, and the group is still there`
    );
    return;
  }
  const recorded = version
    ? historyHeldNothingDevices(userId, workspaceId, version)
    : new Set<string>();

  const label = `community ${workspaceId.slice(0, 8)}`;
  const read = electionRoster(
    await channels().listWorkspaceMembers(workspaceId, { presence: true }),
    label
  );
  const { roster } = read;
  const tree = await treeDevicesOn(groupId);
  const answering = answeringDevicesIn(tree, read.devices, label);
  const online = answering ? reachableThroughDevices(read.online, answering) : read.online;
  const heldView = heldNothingView(roster, tree, recorded, answering);
  // OUR OWN OTHER DEVICES ARE MEMBERS TOO. A community whose only MEMBER is us is not a community
  // with nobody to ask: the seeds are held by whichever device of ours minted them, and that device
  // is on this very group. Read as "nothing to ask for", this line was the whole of COMM-18's
  // failure on 2026-08-25 - a phone that had just joined a solo community, sitting in front of a
  // message its owner's laptop held the seed for, having asked no one.
  //
  // AND ONLY A MEMBER WITH A DEVICE ONLINE, for the reason {@link resolveAnswerer} gives: the lowest
  // id regardless of presence was, on production 2026-09-24, a member offline for two days, asked at
  // every load and never answering.
  //
  // AND OUR OWN DEVICES OBEY THE SAME RULE. The request is a transport frame, dropped for a device
  // presence reports offline, so naming ourselves when presence says NONE of our other devices is
  // online sends a request nobody can receive. The Mi 9T asked itself for the history of eight bench
  // communities at EVERY launch this way (`asked <self> (every device) ... no-seed-held`,
  // 2026-10-15), its only other device offline: eight roster reads and eight sealed sends a launch,
  // into the void. `answering === null` is a server that did not say (older than 1.2.5) and keeps
  // the old reading - our devices treated as reachable.
  //
  // AND NEVER A DEVICE THAT ALREADY ANSWERED "I HOLD NOTHING" AT THIS TREE (section 24): a member is
  // skipped when every device of theirs on the tree answered (`exhausted`), or when every device of
  // theirs online did and the rest are offline (`spent`) - and the next member is asked instead. One
  // member's "nothing" says nothing about the others, and one device's says nothing about its
  // siblings - which is why the record is keyed on the device.
  const other = lowestOtherMember(roster, userId, heldView.skipped, online);
  const ownOnGroup =
    other === null && !heldView.exhausted(userId) && (await ownDevicesOnTheGroup(scope));
  const ownOnline = answering === null || heldView.unansweredOnline(userId).length > 0;
  const answerer = other ?? (ownOnGroup && ownOnline ? userId : null);
  const offline = [...roster]
    .filter((id) => id !== userId && !online.has(id) && !heldView.done(id))
    .sort();
  if (!answerer && offline.length > 0) {
    parkHistoryUntilOnline(workspaceId, offline);
    return;
  }
  const waitingOnDevice = [...roster].filter(
    (id) => id !== userId && online.has(id) && !heldView.done(id)
  );
  if (!answerer && waitingOnDevice.length > 0) {
    // Online, but only on devices that already answered "nothing" - their other devices on the tree
    // are offline and may hold the past. NOT parked on presence: its waiter watches USERS and these
    // users are online, so it would fire at once; no per-device waiter exists (backlog, "Four things
    // the offline cold start fix left open"). Filed against the epoch: the next start reads presence
    // again and asks such a device the moment it is online.
    if (epoch !== null) historyUnanswerableAt.set(workspaceId, epoch);
    console.info(
      `[GRAINE] the history of community ${workspaceId.slice(0, 8)} waits for a device: ` +
        `${waitingOnDevice.length} member(s) answered "I hold nothing" from every device online, and ` +
        `each has another device on the key group, offline - asked at the next start`
    );
    return;
  }
  if (!answerer && ownOnGroup) {
    // Our other devices hold this group and none is online. Filed against the epoch so a pass that
    // changes nothing says nothing again - which is what the request sent into the void used to buy
    // through `historyAsked`: one per session. The next start reads presence again. NOT parked like
    // the other members ({@link parkHistoryUntilOnline}): the presence store's waiter watches USERS,
    // and this user is online by definition (it is us), so it would fire at once - no per-device
    // waiter exists yet (backlog, "Four things the offline cold start fix left open").
    if (epoch !== null) historyUnanswerableAt.set(workspaceId, epoch);
    console.info(
      `[GRAINE] the history of community ${workspaceId.slice(0, 8)} is not asked: no other member, ` +
        `and none of our other devices on its key group is online to receive the request`
    );
    return;
  }
  if (!answerer && version && recorded.size > 0 && heldView.everyDeviceAnswered(userId)) {
    // FINAL FOR THIS TREE: every device that could hold the past - each device of each other member,
    // and our own other devices - is a leaf of the key group that was asked at this epoch and said it
    // holds nothing. Read from the TREE, never presence, so a device that was offline throughout is
    // not final by omission. Durable, so the next start skips even the roster read; the tree cannot
    // change without moving the epoch, which is what asks again.
    markHistoryHeldNothingFinal(userId, workspaceId, version);
    historyUnanswerableAt.set(workspaceId, version.epoch);
    // A widened ask that every device answered with "nothing" has its answer too.
    settleWidening(userId, workspaceId, 'every device on the key group holds nothing');
    console.info(
      `[GRAINE] the history of community ${workspaceId.slice(0, 8)} is final at distribution epoch ` +
        `${version.epoch}: all ${recorded.size} device(s) on its key group hold nothing - asked again when the tree moves`
    );
    return;
  }
  if (!answerer) {
    // Genuinely nobody RIGHT NOW: no second member, and no second device of ours on the group. Said
    // once per roster rather than retried on every load - and it is a roster this device does not
    // control, so the next epoch gets its own answer.
    if (epoch !== null) historyUnanswerableAt.set(workspaceId, epoch);
    // Nobody else, and no other device of ours: there is no past held anywhere this device lacks.
    settleWidening(userId, workspaceId, 'nobody else holds the community');
    console.info(
      `[GRAINE] community ${workspaceId.slice(0, 8)} has no other member and no other device of ours to ask for history` +
        (epoch === null
          ? ' - and its distribution group is not ridable yet, so this is re-asked on the next pass'
          : ` (distribution epoch ${epoch}) - re-asked when that epoch moves`)
    );
    return;
  }

  // Only the devices that have not answered yet: one that said "nothing" at this tree would say it
  // again, and naming it would count for nothing.
  const answererDevices = heldView.unansweredOnline(answerer);
  const requestId = crypto.randomUUID();
  const frame = encodeAppMessage(
    mkGraineRequest({
      workspaceId,
      kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_HISTORY,
      answererUserId: answerer,
      answererDeviceIds: answererDevices,
      requestId,
    })
  );
  // RECORDED BEFORE THE SEND, not after it: the answer travels over the socket while the send's
  // own HTTP answer is still on its way back, so an "I hold nothing" may be handled before the
  // `await` resumes - and against no request in flight it would be ignored. Replaces any earlier
  // ask of this community: a late answer to a superseded request answers a question no longer
  // asked.
  historyRequest.set(workspaceId, {
    requestId,
    answerer: answerer.toLowerCase(),
    pending: answererDevices.length > 0 ? new Set(answererDevices) : null,
    unanswered: heldView.unansweredOnTree(answerer),
    groupId,
    epoch,
  });
  // DURABLE beside it, so a page of the answer absorbed after a restart is still known as ours.
  const undoHistoryAsked = noteHistoryAsked(
    userId,
    workspaceId,
    requestId,
    missingPages !== null && !evenIfSeedsHeld
  );
  try {
    await mlsService.sendMessage(groupId, frame, undefined, DELIVERY.transport);
  } catch (e) {
    // Nothing went out, so nothing can answer it; the caller says why the ask failed. Nor is the
    // one re-ask of an incomplete answer spent on it.
    historyRequest.delete(workspaceId);
    undoHistoryAsked();
    throw e;
  }
  historyAsked.add(workspaceId);
  historyParked.get(workspaceId)?.();
  historyParked.delete(workspaceId);
  // A request IS outstanding now, and `historyAsked` is what says so. Leaving a stale epoch here
  // would be a second thing claiming to decide the same question.
  historyUnanswerableAt.delete(workspaceId);
  console.info(
    `[GRAINE] asked ${answerer} (${describeNamedDevices(answererDevices)}) for the history of community ` +
      `${workspaceId.slice(0, 8)} at epoch ${mlsService.getEpoch(groupId)} - reason ` +
      `${evenIfSeedsHeld ? 'key-group-rejoined' : widening !== 'none' ? 'visibility-widened' : 'no-seed-held'}, key group lost ` +
      `${describeKeyGroupFrameLosses(groupId)} this session`
  );
}

/**
 * Holds a community's history request until one of its `offline` members comes online, then asks
 * again from the top - a fresh roster, a fresh election.
 */
function parkHistoryUntilOnline(workspaceId: string, offline: string[]): void {
  historyParked.get(workspaceId)?.();
  console.info(
    `[GRAINE] the history of community ${workspaceId.slice(0, 8)} waits for a member to come ` +
      `online - ${offline.length} member(s) could answer and none has a device online`
  );
  const cancel = whenAnyComesOnline(offline, (back) => {
    historyParked.delete(workspaceId);
    console.info(
      `[GRAINE] ${back.length} member(s) of community ${workspaceId.slice(0, 8)} came online - ` +
        `asking for its history`
    );
    requestCommunityHistory(workspaceId).catch((e) =>
      console.warn(
        `[GRAINE] could not ask for the history of community ${workspaceId.slice(0, 8)}: ` +
          String(e)
      )
    );
  });
  historyParked.set(workspaceId, cancel);
}

/**
 * A device asked for the history of `workspaceId` has answered "I hold nothing" (section 24).
 *
 * **The DEVICE is recorded**, durably, against the key group and the epoch the request was sealed
 * at ({@link recordHistoryHeldNothing}) - never its member: a member counts as answered only once
 * every device of theirs on the key group's tree has said it. Once every device the request named
 * has answered (or, when it named none, every device of the member on the tree), the NEXT member is
 * asked at once: the election skips a member whose devices online all answered, and the ask is
 * final only when every device on the tree did ({@link requestCommunityHistory}). Bound to the
 * request in flight exactly as a session decline is ({@link noteSeedUnavailable}): the id, the member
 * it was addressed to, and a device it named. Anything else - a superseded ask, a member never asked,
 * a device not named or already counted - is ignored at debug, because it answers a question nobody
 * is waiting on.
 *
 * @param answerer Who answered, any case - checked against the MLS credential that sealed the frame.
 * @param requestId The request the bundle echoes.
 * @param answererDevice The device the delivery envelope names. SELF-ASSERTED on this path: only the
 *   user is checked against the credential, so it counts only as one device the request named or the
 *   tree holds, and once (see `historyRequest`).
 */
export function noteHistoryHeldNothing(
  workspaceId: string,
  answerer: string,
  requestId: string,
  answererDevice: string
): void {
  const inFlight = historyRequest.get(workspaceId);
  if (
    !inFlight ||
    inFlight.requestId !== requestId ||
    inFlight.answerer !== answerer.toLowerCase()
  ) {
    console.debug(
      `[GRAINE] ignoring "I hold nothing" for community ${workspaceId.slice(0, 8)} from ${answerer}: ` +
        `it answers request ${requestId || '(none)'}, not the history ask in flight` +
        (inFlight ? ` (addressed to ${inFlight.answerer})` : '')
    );
    return;
  }
  // A DEVICE SPEAKS ONLY FOR ITSELF, and only once: the named devices still to answer when the
  // request named some, else the member's tree devices not yet recorded, else (no tree) any device.
  const expected = inFlight.pending ?? inFlight.unanswered;
  if (answererDevice === '' || (expected !== null && !expected.has(answererDevice))) {
    console.debug(
      `[GRAINE] ignoring "I hold nothing" for community ${workspaceId.slice(0, 8)} from ` +
        `${answerer}:${answererDevice || '(no device)'}: request ${requestId} did not name that ` +
        `device, it is not on the key group's tree, or it has already answered`
    );
    return;
  }
  if (inFlight.epoch === null) {
    // Nothing to key the answer on: the group was not ridable when the request was sealed. Said,
    // and left to the next start - one ask, the cost before this answer existed.
    historyRequest.delete(workspaceId);
    console.info(
      `[GRAINE] ${answerer}:${answererDevice} holds nothing of community ${workspaceId.slice(0, 8)} - ` +
        `not recorded, the request was sealed with no distribution epoch to key it on`
    );
    return;
  }
  const { userId } = requireGraineRuntime('cannot record a history answer');
  const isNew = recordHistoryHeldNothing(
    userId,
    workspaceId,
    { groupId: inFlight.groupId, epoch: inFlight.epoch },
    inFlight.answerer,
    answererDevice
  );
  inFlight.pending?.delete(answererDevice);
  inFlight.unanswered?.delete(answererDevice);
  if (!isNew) {
    console.debug(
      `[GRAINE] ${answerer}:${answererDevice} said again it holds nothing of community ` +
        `${workspaceId.slice(0, 8)} - already recorded at epoch ${inFlight.epoch}, nothing moves`
    );
    return;
  }
  const memberDone = inFlight.unanswered !== null && inFlight.unanswered.size === 0;
  const namedDone = inFlight.pending !== null && inFlight.pending.size === 0;
  if (!memberDone && !namedDone) {
    console.info(
      `[GRAINE] ${answerer}:${answererDevice} holds nothing of community ${workspaceId.slice(0, 8)} - ` +
        `recorded; ${inFlight.pending?.size ?? inFlight.unanswered?.size ?? 'every other'} device(s) ` +
        `of ${answerer} still to answer`
    );
    return;
  }
  historyRequest.delete(workspaceId);
  console.info(
    `[GRAINE] ${answerer}:${answererDevice} holds nothing of community ${workspaceId.slice(0, 8)} at ` +
      `distribution epoch ${inFlight.epoch} - recorded, ` +
      (memberDone
        ? `every device of ${answerer} on the key group has answered`
        : `${inFlight.unanswered?.size ?? 'an unknown number of'} device(s) of ${answerer} on the key group are offline and still unasked`) +
      ' - asking the next member'
  );
  // THE NEXT MEMBER, NOW: the election skips every member whose devices online all answered at this
  // tree, so this walks the roster one member at a time and ends - each pass records at least one
  // more device, or finds nobody left to ask and records the ask final (every device on the tree
  // answered), waits for an offline device, or parks on offline members. Bounded by the tree, not
  // by a clock.
  historyAsked.delete(workspaceId);
  void requestCommunityHistory(workspaceId).catch((e: unknown) => {
    console.warn(
      `[GRAINE] the history of community ${workspaceId.slice(0, 8)} could not be asked of the next member: ${String(e)}`
    );
  });
}

/**
 * The seed arrived: this session is no longer wanted.
 *
 * Called from the frame handler on EVERY path a seed can land by, so `asked` holds only requests
 * still outstanding. Leaving a satisfied session in it costs nothing today and would cost a silence
 * the day a later miss on the same id needs to ask - a repaired seed can still carry a `firstIndex`
 * above the rows that prompted the ask.
 */
export function forgetAskedSession(sessionId: string): void {
  asked.delete(sessionId);
  askedOn.delete(sessionId);
  askedRequest.delete(sessionId);
  wants.delete(sessionId);
  declined.delete(sessionId);
}

/**
 * The chosen answerer has said it does not hold `sessionId`. Ask the next member instead.
 *
 * **This is the difference between one unlucky election and a permanently blank salon.** The
 * answerer is chosen deterministically, so a member who does not hold the seed is chosen by every
 * device alike; without this the request would be answered by silence and the session would never be
 * asked for again in the whole app session.
 *
 * Driven entirely by the ARRIVAL of a declining bundle, so there is no cycle to bound and no clock
 * to be wrong: no answer, no re-ask. Each accepted decline strikes one member off a finite roster,
 * so the walk ends either on the seed or on {@link resolveAnswerer} returning null, which is
 * reported. The FIRST "no" from any device the request named is enough: a device of the same member
 * that does hold the seed and answers late still lands it, because a bundle's seeds are stored
 * whoever asked, and storing one ends the walk ({@link forgetAskedSession}).
 *
 * @param sessionId Session the answerer turned out not to hold.
 * @param answerer Who declined, lower-cased by the caller or here.
 * @param requestId The request the declining bundle answers, which must also have been ADDRESSED to
 *   `answerer`. A decline of any OTHER request (replayed
 *   from the log, or answering an ask since superseded) is ignored: the walk counts answers to the
 *   ask in flight, not every "no" ever said.
 * @param answererDevice The device the declining bundle came from, from its envelope. Must be one
 *   the request named, when it named any.
 */
export function noteSeedUnavailable(
  sessionId: string,
  answerer: string,
  requestId: string,
  answererDevice: string
): void {
  const want = wants.get(sessionId);
  if (!want) {
    // Nothing is waiting on it: the seed landed by another path between the ask and this answer, or
    // the community has since left this device. Either way there is nobody to ask on behalf of.
    return;
  }

  const inFlight = askedRequest.get(sessionId);
  // The id AND the elected member: a member the ask was not addressed to has no standing to strike
  // itself off the roster, whatever id it quotes.
  if (
    !inFlight ||
    inFlight.requestId !== requestId ||
    inFlight.answerer !== answerer.toLowerCase()
  ) {
    console.debug(
      `[GRAINE] ignoring a decline of session ${sessionId} from ${answerer}: it answers request ${requestId || '(none)'}, not the one in flight${inFlight ? ` (addressed to ${inFlight.answerer})` : ''}`
    );
    return;
  }

  // ONLY A DEVICE THE REQUEST NAMED MAY DECLINE FOR IT (section 23): another device of the member
  // was never asked in this walk.
  if (inFlight.named && !inFlight.named.has(answererDevice)) {
    console.debug(
      `[GRAINE] ignoring a decline of session ${sessionId} from ${answerer}:${answererDevice || '(no device)'}: ` +
        `request ${requestId} did not name that device`
    );
    return;
  }

  const tried = declined.get(sessionId) ?? new Set<string>();
  // ONE STRIKE PER MEMBER, ON THE FIRST "NO" FROM A NAMED DEVICE. Waiting for every named device
  // would let one silent device - a backgrounded phone with its socket open - hold the walk for
  // ever, with nothing to wake it. Striking early loses nothing: a device of this member that holds
  // the seed and answers after the walk moved on still lands it (`absorbSeedBundle` stores whatever
  // arrives, and `forgetAskedSession` then ends the walk). A second "no" from the same member would
  // only send a duplicate request down the roster.
  if (tried.has(answerer.toLowerCase())) return;
  tried.add(answerer.toLowerCase());
  declined.set(sessionId, tried);

  console.info(
    `[GRAINE] ${answerer} does not hold session ${sessionId} - asking the next member of the roster`
  );
  // Re-armed BEFORE re-noting: `noteMissingSeed` declines anything already in `asked`, which is
  // exactly where this session still is.
  asked.delete(sessionId);
  askedOn.delete(sessionId);
  noteMissingSeed(want.channelId, sessionId, want.senderId, want.sentAt, 'declined');
}

/**
 * Forgets what was asked on behalf of a community that is leaving this device.
 *
 * `historyAsked` in particular MUST go: a member who leaves and rejoins holds no seed again, and a
 * stale "already asked this session" entry would silence the one request that repopulates them.
 *
 * @param workspaceId Community leaving this device.
 * @param sessionIds Sessions purged with it, so a later miss on the same id may ask again.
 */
export function forgetWorkspaceRepairState(
  workspaceId: string,
  sessionIds: readonly string[]
): void {
  historyAsked.delete(workspaceId);
  historyUnanswerableAt.delete(workspaceId);
  historyRequest.delete(workspaceId);
  if (isGraineReady()) {
    const { userId } = requireGraineRuntime('cannot forget a history answer');
    forgetHistoryHeldNothing(userId, workspaceId);
    forgetHistoryClosedSeen(userId, workspaceId);
    forgetPagedHistoryAnswer(userId, workspaceId);
  } else {
    // Left in place: it names this community's key group and epoch, which a re-join replaces, so it
    // answers nothing then - but a leave with no runtime is worth naming.
    console.debug(
      `[GRAINE] the "I hold nothing" record of community ${workspaceId.slice(0, 8)} is kept: no runtime to name its account`
    );
  }
  historyParked.get(workspaceId)?.();
  historyParked.delete(workspaceId);
  // A parked channel waiter of this community may still fire; it re-asks only what is still in
  // `wants`, which the loop below empties of this community's sessions.
  for (const sessionId of sessionIds) forgetAskedSession(sessionId);
}

/** Puts `sessions` aside until `groupId` catches up, and says so once per batch. */
function holdForKeyGroup(
  groupId: string,
  channelId: string,
  sessions: Map<string, MissingSeed>
): void {
  if (sessions.size === 0) return;
  const byChannel = heldForKeyGroup.get(groupId) ?? new Map<string, Map<string, MissingSeed>>();
  const merged = byChannel.get(channelId) ?? new Map<string, MissingSeed>();
  for (const [sessionId, seed] of sessions) merged.set(sessionId, seed);
  byChannel.set(channelId, merged);
  heldForKeyGroup.set(groupId, byChannel);
  console.info(
    `[GRAINE] ${sessions.size} seed request(s) for channel ${channelId.slice(0, 8)} held - key group ${groupId.slice(0, 8)}... is behind its epoch, and a request sealed now would be read by nobody`
  );
}

/**
 * Sends what waited for `groupId` to catch up, and asks AGAIN for what went out at an epoch it has
 * since left. Called when the key group's gap closes, or it was re-joined.
 *
 * @param groupId The key group that caught up.
 * @param rejoinedWorkspace The community whose key group was RE-JOINED, when it was: its history is
 *   asked for even though seeds are held (see {@link requestCommunityHistory}).
 */
export function releaseRequestsHeldForKeyGroup(groupId: string, rejoinedWorkspace?: string): void {
  if (!isGraineReady()) return;
  const { mlsService } = requireGraineRuntime('cannot release held seed requests');
  const now = mlsService.getEpoch(groupId);
  let reasked = 0;
  let released = 0;

  for (const [channelId, sessions] of heldForKeyGroup.get(groupId) ?? []) {
    const perChannel = outstanding.get(channelId) ?? new Map<string, MissingSeed>();
    for (const [sessionId, seed] of sessions) perChannel.set(sessionId, seed);
    outstanding.set(channelId, perChannel);
    released += sessions.size;
  }
  heldForKeyGroup.delete(groupId);

  for (const [sessionId, at] of askedOn) {
    if (at.groupId !== groupId || at.epoch >= now) continue;
    asked.delete(sessionId);
    askedOn.delete(sessionId);
    // The ask sealed at the epoch this device has left is SUPERSEDED: a late decline of it must not
    // be counted against the ask that replaces it.
    askedRequest.delete(sessionId);
    const want = wants.get(sessionId);
    if (!want) continue;
    const perChannel = outstanding.get(want.channelId) ?? new Map<string, MissingSeed>();
    perChannel.set(sessionId, {
      senderId: want.senderId,
      sentAt: want.sentAt,
      reason: 'epoch-left',
    });
    outstanding.set(want.channelId, perChannel);
    reasked++;
  }

  const communities = historyHeldForKeyGroup.get(groupId) ?? new Set<string>();
  historyHeldForKeyGroup.delete(groupId);
  if (rejoinedWorkspace) communities.add(rejoinedWorkspace);
  for (const workspaceId of communities) {
    requestCommunityHistory(workspaceId, {
      evenIfSeedsHeld: workspaceId === rejoinedWorkspace,
    }).catch((e) =>
      console.warn(
        `[GRAINE] could not ask for the history of community ${workspaceId.slice(0, 8)}: ` +
          String(e)
      )
    );
  }

  if (released + reasked + communities.size > 0) {
    console.info(
      `[GRAINE] key group ${groupId.slice(0, 8)}... caught up (epoch ${now}) - ${released} held request(s) released, ` +
        `${reasked} re-asked (sealed at an epoch it has left), ${communities.size} history request(s)`
    );
  }
  if (outstanding.size > 0 && !flushing) void flushRepairs();
}

/** Test seam: drops every in-memory trace of what has been asked. */
export function resetGraineRepairState(): void {
  asked.clear();
  askedOn.clear();
  askedRequest.clear();
  heldForKeyGroup.clear();
  historyHeldForKeyGroup.clear();
  wants.clear();
  declined.clear();
  outstanding.clear();
  historyAsked.clear();
  historyUnanswerableAt.clear();
  historyRequest.clear();
  for (const { cancel } of parked.values()) cancel();
  parked.clear();
  for (const cancel of historyParked.values()) cancel();
  historyParked.clear();
  flushing = false;
}
