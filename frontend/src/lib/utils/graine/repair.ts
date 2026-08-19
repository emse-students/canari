import { canari } from '$lib/proto/canari';
import { encodeAppMessage, mkGraineRequest } from '$lib/proto/codec';
import { DELIVERY } from '$lib/mls-client/frameDelivery';
import { workspaceScope } from '$lib/mls-client/distributionScope';
import { ChannelService } from '$lib/services/ChannelService';
import { requireGraineRuntime, scopeForChannel } from './runtime';
import { GraineDistributionUnavailableError } from './seedDistribution';

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
const wants = new Map<string, { channelId: string; senderId: string }>();

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
const outstanding = new Map<string, Map<string, string>>();

/** Communities whose history has been asked for in this app session. Same lifetime, same reason. */
const historyAsked = new Set<string>();

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
export function noteMissingSeed(channelId: string, sessionId: string, senderId: string): void {
  if (!sessionId || asked.has(sessionId)) return;
  const perChannel = outstanding.get(channelId) ?? new Map<string, string>();
  perChannel.set(sessionId, senderId.toLowerCase());
  outstanding.set(channelId, perChannel);
  // Kept for the re-ask: the row that named this session has already been dropped from the render,
  // so nothing would come back to supply the channel and the sender a second time.
  wants.set(sessionId, { channelId, senderId: senderId.toLowerCase() });
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
            (e instanceof Error ? e.message : String(e))
        );
        continue;
      }
      const sessions = outstanding.get(channelId) ?? new Map<string, string>();
      outstanding.delete(channelId);
      try {
        await requestSeedsForChannel(channelId, sessions, targets);
      } catch (e) {
        // Best-effort, and therefore said out loud: the only other symptom is a salon whose older
        // messages stay unreadable with nothing anywhere naming the reason.
        console.warn(
          `[GRAINE] could not ask for ${sessions.size} missing seed(s) in channel ${channelId.slice(0, 8)}: ` +
            (e instanceof Error ? e.message : String(e))
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
  const members = (await channels().listMembers(channelId, memberScope)).map((m) =>
    String(m.userId).toLowerCase()
  );
  return { workspaceId, groupId, roster: new Set(members) };
}

/** Sends one request per answerer for `sessions` of `channelId`. */
async function requestSeedsForChannel(
  channelId: string,
  sessions: Map<string, string>,
  { workspaceId, groupId, roster }: RepairTargets
): Promise<void> {
  const { mlsService, userId } = requireGraineRuntime('cannot ask for a missing seed');

  // ONE named answerer per request, never a broadcast: every member holding the seed would
  // otherwise answer at once, so a salon of three hundred would pay three hundred bundles for one
  // missing session.
  const byAnswerer = new Map<string, string[]>();
  for (const [sessionId, senderId] of sessions) {
    const answerer = resolveAnswerer(senderId, roster, userId, declined.get(sessionId));
    if (!answerer) {
      // The roster is exhausted: everyone who could have held it has been asked and has said no.
      // That is the walk TERMINATING on a proof, so the want is dropped rather than left to be
      // retried for ever - and it is said once, here, rather than discovered as a permanently blank
      // message every time the salon is opened.
      console.warn(
        `[GRAINE] session ${sessionId} of channel ${channelId.slice(0, 8)} has no reachable holder - ` +
          `its sender ${senderId} is gone or does not hold it, and every other member has declined`
      );
      wants.delete(sessionId);
      declined.delete(sessionId);
      continue;
    }
    byAnswerer.set(answerer, [...(byAnswerer.get(answerer) ?? []), sessionId]);
  }

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
 * Who to address a request to: the session's own sender, or the lowest user id still in the
 * community that has not already declined.
 *
 * The sender always holds the seed, so they are the answer whenever they are still reachable. When
 * they are not, SOME member has to be picked and every device has to pick the same one without
 * talking to any other - so it is the lowest id, which is a total order every device already has.
 * No clock, no election, nothing for a race to decide.
 *
 * **Never ourselves.** The sender of a session can be this very user - another device of theirs
 * minted it - and a request addressed to us reaches only us, who are asking precisely because we do
 * not hold it. It would cost a round trip and answer nothing.
 *
 * **Never someone who has said no.** Determinism is what makes the choice safe and is also what
 * would make it a dead end: a member elected by the rule but holding nothing would be elected again
 * on every retry. `tried` is what turns one election into a walk down the roster, and because the
 * roster is finite the walk ends - on the seed, or on `null`, which the caller reports.
 *
 * @param senderId Who minted the session; the first candidate whenever they are still a member.
 * @param roster Community members, lower-cased.
 * @param self This user, never a candidate.
 * @param tried Members who have already answered that they do not hold it.
 */
export function resolveAnswerer(
  senderId: string,
  roster: Set<string>,
  self: string,
  tried?: ReadonlySet<string>
): string | null {
  const sender = senderId.toLowerCase();
  const me = self.toLowerCase();
  if (sender !== me && roster.has(sender) && !tried?.has(sender)) return sender;
  return lowestOtherMember(roster, me, tried);
}

/**
 * The lowest user id in the roster that is neither us nor already tried, or null when there is
 * nobody left - which is the proof that ends the walk.
 */
function lowestOtherMember(
  roster: Set<string>,
  self: string,
  tried?: ReadonlySet<string>
): string | null {
  return [...roster].filter((id) => id !== self && !tried?.has(id)).sort()[0] ?? null;
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
 * Best-effort by construction: it is called from the join path and must never fail it. Every branch
 * says what it did, because the alternative symptom is a joiner staring at an empty salon.
 */
export async function requestCommunityHistory(workspaceId: string): Promise<void> {
  if (historyAsked.has(workspaceId)) return;
  const { storage, deviceKeyB64, userId, mlsService } = requireGraineRuntime(
    'cannot ask for community history'
  );

  const held = await storage.getGraineSessionsForWorkspace(workspaceId, deviceKeyB64);
  if (held.length > 0) return;

  const scope = workspaceScope(workspaceId);
  const groupId = mlsService.distributionGroupFor(scope);
  if (!groupId) throw new GraineDistributionUnavailableError(scope);

  const roster = new Set(
    (await channels().listWorkspaceMembers(workspaceId)).map((m) => String(m.userId).toLowerCase())
  );
  const answerer = lowestOtherMember(roster, userId);
  if (!answerer) {
    // A community whose only member is us. Nothing to ask for and nobody to ask; said once rather
    // than retried on every load.
    historyAsked.add(workspaceId);
    console.info(
      `[GRAINE] community ${workspaceId.slice(0, 8)} has no other member to ask for history`
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
  console.info(
    `[GRAINE] asked ${answerer} for the history of community ${workspaceId.slice(0, 8)}`
  );
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
  noteMissingSeed(want.channelId, sessionId, want.senderId);
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
  for (const sessionId of sessionIds) forgetAskedSession(sessionId);
}

/** Test seam: drops every in-memory trace of what has been asked. */
export function resetGraineRepairState(): void {
  asked.clear();
  wants.clear();
  declined.clear();
  outstanding.clear();
  historyAsked.clear();
  flushing = false;
}
