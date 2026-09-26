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
import { requireGraineRuntime, scopeForChannel } from './runtime';
import { historyFloorFor, withinHistoryFloor } from './historyBoundary';
import { distributionEpochFor, GraineDistributionUnavailableError } from './seedDistribution';

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
const wants = new Map<string, { channelId: string; senderId: string; sentAt: number }>();

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
  sentAt: number | undefined
): void {
  if (!sessionId || asked.has(sessionId)) return;
  const perChannel = outstanding.get(channelId) ?? new Map<string, MissingSeed>();
  const sender = senderId.toLowerCase();
  const dated = typeof sentAt === 'number' && Number.isFinite(sentAt) ? sentAt : Infinity;
  const seen = Math.max(dated, perChannel.get(sessionId)?.sentAt ?? 0);
  perChannel.set(sessionId, { senderId: sender, sentAt: seen });
  outstanding.set(channelId, perChannel);
  // Kept for the re-ask: the row that named this session has already been dropped from the render,
  // so nothing would come back to supply the channel, the sender and the date a second time.
  wants.set(sessionId, { channelId, senderId: sender, sentAt: seen });
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
      const sessions = outstanding.get(channelId) ?? new Map<string, MissingSeed>();
      outstanding.delete(channelId);
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
}

/** Resolves the community, the group carrying the salon's seeds, and the roster to ask. */
async function resolveRepairTargets(channelId: string): Promise<RepairTargets> {
  const { mlsService } = requireGraineRuntime('cannot ask for a missing seed');
  const scope = scopeForChannel(channelId);
  if (!scope) throw new Error(`channel ${channelId} belongs to no loaded community`);
  const workspaceId = scope.workspaceId;
  const groupId = mlsService.distributionGroupFor(scope);
  if (!groupId) throw new GraineDistributionUnavailableError(scope);

  // THE ROSTER TO ASK IS THE ROSTER THAT HOLDS THE SEED. On a private salon that is the salon's own
  // members, and asking the community's would name an answerer who cannot even see the request -
  // it travels on the salon's group, which they are not in.
  const memberScope = scope.kind === 'channel' ? 'channel' : 'workspace';
  const { roster, online } = electionRoster(
    await channels().listMembers(channelId, memberScope, { presence: true }),
    `channel ${channelId.slice(0, 8)}`
  );
  return {
    workspaceId,
    groupId,
    roster,
    online,
    ownOtherDevices: await ownDevicesOnTheGroup(scope),
  };
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
} {
  const roster = new Set<string>();
  const online = new Set<string>();
  let unanswered = 0;
  for (const row of rows) {
    const id = String(row.userId).toLowerCase();
    roster.add(id);
    if (typeof row.online !== 'boolean') unanswered++;
    if (row.online !== false) online.add(id);
  }
  if (unanswered > 0) {
    console.warn(
      `[GRAINE] the roster of ${label} came back without presence for ${unanswered} member(s) - ` +
        `electing them as if online; the social service answering it predates the presence field`
    );
  }
  return { roster, online };
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
  { workspaceId, groupId, roster, online, ownOtherDevices }: RepairTargets
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
      declined.delete(sessionId);
      continue;
    }
    const { answerer } = election;
    byAnswerer.set(answerer, [...(byAnswerer.get(answerer) ?? []), sessionId]);
  }
  if (waiting.size > 0) parkUntilOnline(channelId, waiting);

  for (const [answerer, sessionIds] of byAnswerer) {
    const frame = encodeAppMessage(
      mkGraineRequest({
        workspaceId,
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
        sessionIds,
        answererUserId: answerer,
        requestId: crypto.randomUUID(),
      })
    );
    // Transport, never durable: a request restates state held elsewhere, so replaying it from the
    // shared log would be circular - and that log is capped per group, so writing requests into it
    // would evict the seeds it exists to carry.
    await mlsService.sendMessage(groupId, frame, undefined, DELIVERY.transport);
    sessionIds.forEach((id) => asked.add(id));
    console.info(
      `[GRAINE] asked ${answerer} for ${sessionIds.length} seed(s) in community ${workspaceId.slice(0, 8)}`
    );
  }
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
      if (want) noteMissingSeed(want.channelId, sessionId, want.senderId, want.sentAt);
    }
  });
  parked.set(channelId, { sessions: merged, cancel });
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
 * Best-effort by construction: it is called from the join path and must never fail it. Every branch
 * says what it did, because the alternative symptom is a joiner staring at an empty salon.
 */
export async function requestCommunityHistory(workspaceId: string): Promise<void> {
  if (historyAsked.has(workspaceId)) return;
  const { storage, deviceKeyB64, userId, mlsService } = requireGraineRuntime(
    'cannot ask for community history'
  );

  // HOLDING SOME SEEDS IS NOT HOLDING THE PAST - a member back in a community holds exactly the
  // seeds sent since the return. That past is not this request's to fetch: every row this device
  // cannot open names its session and asks for it ({@link noteMissingSeed}), which is what derives
  // what is missing from the messages themselves. On 2026-09-24 that path failed too, only because
  // it addressed offline members; it elects among the online ones now. Asking the whole bundle again
  // here at every start, of one member, for seeds this device mostly holds, would buy nothing that
  // path does not already deliver session by session.
  const held = await storage.getGraineSessionsForWorkspace(workspaceId, deviceKeyB64);
  if (held.length > 0) return;

  const scope = workspaceScope(workspaceId);
  const groupId = mlsService.distributionGroupFor(scope);
  if (!groupId) throw new GraineDistributionUnavailableError(scope);

  // Before the roster read below, which is a network call: a pass that finds the same epoch is a
  // pass asking the same question of the same people, and it already has the answer. `null` is not
  // an epoch and never matches one - a group this device cannot ride yet is not evidence about who
  // is on it.
  const epoch = distributionEpochFor(mlsService, scope);
  if (epoch !== null && historyUnanswerableAt.get(workspaceId) === epoch) return;

  const { roster, online } = electionRoster(
    await channels().listWorkspaceMembers(workspaceId, { presence: true }),
    `community ${workspaceId.slice(0, 8)}`
  );
  // OUR OWN OTHER DEVICES ARE MEMBERS TOO. A community whose only MEMBER is us is not a community
  // with nobody to ask: the seeds are held by whichever device of ours minted them, and that device
  // is on this very group. Read as "nothing to ask for", this line was the whole of COMM-18's
  // failure on 2026-08-25 - a phone that had just joined a solo community, sitting in front of a
  // message its owner's laptop held the seed for, having asked no one.
  //
  // AND ONLY A MEMBER WITH A DEVICE ONLINE, for the reason {@link resolveAnswerer} gives: the lowest
  // id regardless of presence was, on production 2026-09-24, a member offline for two days, asked at
  // every load and never answering.
  const answerer =
    lowestOtherMember(roster, userId, undefined, online) ??
    ((await ownDevicesOnTheGroup(scope)) ? userId : null);
  const offline = [...roster].filter((id) => id !== userId && !online.has(id)).sort();
  if (!answerer && offline.length > 0) {
    parkHistoryUntilOnline(workspaceId, offline);
    return;
  }
  if (!answerer) {
    // Genuinely nobody RIGHT NOW: no second member, and no second device of ours on the group. Said
    // once per roster rather than retried on every load - and it is a roster this device does not
    // control, so the next epoch gets its own answer.
    if (epoch !== null) historyUnanswerableAt.set(workspaceId, epoch);
    console.info(
      `[GRAINE] community ${workspaceId.slice(0, 8)} has no other member and no other device of ours to ask for history` +
        (epoch === null
          ? ' - and its distribution group is not ridable yet, so this is re-asked on the next pass'
          : ` (distribution epoch ${epoch}) - re-asked when that epoch moves`)
    );
    return;
  }

  const frame = encodeAppMessage(
    mkGraineRequest({
      workspaceId,
      kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_HISTORY,
      answererUserId: answerer,
      requestId: crypto.randomUUID(),
    })
  );
  await mlsService.sendMessage(groupId, frame, undefined, DELIVERY.transport);
  historyAsked.add(workspaceId);
  historyParked.get(workspaceId)?.();
  historyParked.delete(workspaceId);
  // A request IS outstanding now, and `historyAsked` is what says so. Leaving a stale epoch here
  // would be a second thing claiming to decide the same question.
  historyUnanswerableAt.delete(workspaceId);
  console.info(
    `[GRAINE] asked ${answerer} for the history of community ${workspaceId.slice(0, 8)}`
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
 * The seed arrived: this session is no longer wanted.
 *
 * Called from the frame handler on EVERY path a seed can land by, so `asked` holds only requests
 * still outstanding. Leaving a satisfied session in it costs nothing today and would cost a silence
 * the day a later miss on the same id needs to ask - a repaired seed can still carry a `firstIndex`
 * above the rows that prompted the ask.
 */
export function forgetAskedSession(sessionId: string): void {
  asked.delete(sessionId);
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
 * to be wrong: no answer, no re-ask. Each pass strikes one member off a finite roster, so the walk
 * ends either on the seed or on {@link resolveAnswerer} returning null, which is reported.
 *
 * @param sessionId Session the answerer turned out not to hold.
 * @param answerer Who declined, lower-cased by the caller or here.
 */
export function noteSeedUnavailable(sessionId: string, answerer: string): void {
  const want = wants.get(sessionId);
  if (!want) {
    // Nothing is waiting on it: the seed landed by another path between the ask and this answer, or
    // the community has since left this device. Either way there is nobody to ask on behalf of.
    return;
  }

  const tried = declined.get(sessionId) ?? new Set<string>();
  tried.add(answerer.toLowerCase());
  declined.set(sessionId, tried);

  console.info(
    `[GRAINE] ${answerer} does not hold session ${sessionId} - asking the next member of the roster`
  );
  // Re-armed BEFORE re-noting: `noteMissingSeed` declines anything already in `asked`, which is
  // exactly where this session still is.
  asked.delete(sessionId);
  noteMissingSeed(want.channelId, sessionId, want.senderId, want.sentAt);
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
  historyParked.get(workspaceId)?.();
  historyParked.delete(workspaceId);
  // A parked channel waiter of this community may still fire; it re-asks only what is still in
  // `wants`, which the loop below empties of this community's sessions.
  for (const sessionId of sessionIds) forgetAskedSession(sessionId);
}

/** Test seam: drops every in-memory trace of what has been asked. */
export function resetGraineRepairState(): void {
  asked.clear();
  wants.clear();
  declined.clear();
  outstanding.clear();
  historyAsked.clear();
  historyUnanswerableAt.clear();
  for (const { cancel } of parked.values()) cancel();
  parked.clear();
  for (const cancel of historyParked.values()) cancel();
  historyParked.clear();
  flushing = false;
}
