import { canari } from '$lib/proto/canari';
import { encodeAppMessage, mkGraineRequest } from '$lib/proto/codec';
import { DELIVERY } from '$lib/mls-client/frameDelivery';
import { ChannelService } from '$lib/services/ChannelService';
import { requireGraineRuntime, workspaceForChannel } from './runtime';
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
 */
const asked = new Set<string>();

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

/** Resolves the community, its distribution group and its roster for `channelId`. */
async function resolveRepairTargets(channelId: string): Promise<RepairTargets> {
  const { mlsService } = requireGraineRuntime('cannot ask for a missing seed');
  const workspaceId = workspaceForChannel(channelId);
  if (!workspaceId) throw new Error(`channel ${channelId} belongs to no loaded community`);
  const groupId = mlsService.distributionGroupFor(workspaceId);
  if (!groupId) throw new GraineDistributionUnavailableError(workspaceId);

  const members = (await channels().listMembers(channelId, 'workspace')).map((m) =>
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
    const answerer = resolveAnswerer(senderId, roster, userId);
    if (!answerer) {
      // Nobody is left who could hold it. Said once, here, rather than discovered as a permanently
      // blank message every time the salon is opened.
      console.warn(
        `[GRAINE] session ${sessionId} of channel ${channelId.slice(0, 8)} has no reachable holder - ` +
          `its sender ${senderId} has left and the community is empty of anyone else`
      );
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
 * community.
 *
 * The sender always holds the seed, so they are the answer whenever they are still reachable. When
 * they are not, SOME member has to be picked and every device has to pick the same one without
 * talking to any other - so it is the lowest id, which is a total order every device already has.
 * No clock, no election, nothing for a race to decide.
 *
 * **Never ourselves.** The sender of a session can be this very user - another device of theirs
 * minted it - and a request addressed to us reaches only us, who are asking precisely because we do
 * not hold it. It would cost a round trip and answer nothing.
 */
export function resolveAnswerer(
  senderId: string,
  roster: Set<string>,
  self: string
): string | null {
  const sender = senderId.toLowerCase();
  const me = self.toLowerCase();
  if (sender !== me && roster.has(sender)) return sender;
  return lowestOtherMember(roster, me);
}

/** The lowest user id in the roster that is not us, or null when there is nobody else. */
function lowestOtherMember(roster: Set<string>, self: string): string | null {
  return [...roster].filter((id) => id !== self).sort()[0] ?? null;
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

  const groupId = mlsService.distributionGroupFor(workspaceId);
  if (!groupId) throw new GraineDistributionUnavailableError(workspaceId);

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

/** Forgets that `sessionId` was asked for, so a later miss may ask again. */
export function forgetAskedSession(sessionId: string): void {
  asked.delete(sessionId);
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
  for (const sessionId of sessionIds) asked.delete(sessionId);
}

/** Test seam: drops every in-memory trace of what has been asked. */
export function resetGraineRepairState(): void {
  asked.clear();
  outstanding.clear();
  historyAsked.clear();
  flushing = false;
}
