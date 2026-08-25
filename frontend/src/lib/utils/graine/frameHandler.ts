import type { DistributionFrame } from '$lib/mls-client/IMlsService';
import type { IStorage, StoredGraineSession } from '$lib/db/types';
import type { canari } from '$lib/proto/canari';
import { canari as canariRuntime } from '$lib/proto/canari';
import { decodeAppMessage, encodeAppMessage, mkGraineBundle } from '$lib/proto/codec';
import { DELIVERY } from '$lib/mls-client/frameDelivery';
import { GRAINE_HISTORY_BUNDLE_MAX_SEEDS } from '$lib/crypto/graineConstants';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import {
  announceGraineRepair,
  cacheGraineSession,
  historyVisibilityFor,
  requireGraineRuntime,
} from './runtime';
import { historyFloorsFor } from './historyBoundary';
import { mirrorGraineSeed } from './graineMirror';
import { forgetAskedSession, noteSeedUnavailable } from './repair';

/**
 * What a frame arriving on a community's distribution group MEANS.
 *
 * The group carries key material and never a message body, so there are exactly three things it
 * can say: here is a seed, send me seeds, here are the seeds you asked for. This module is the
 * handler the MLS layer hands them to (`onDistributionFrame`), and it is the only place that
 * decides what to do with one.
 *
 * Protocol: `docs/wiki/protocols/channel-encryption.md`.
 */

/**
 * Stores an incoming Graine seed, or explains why it was ignored.
 *
 * @returns true when the seed is now held (including when it already was).
 */
export async function storeIncomingSeed(
  workspaceId: string,
  senderId: string,
  seed: {
    channelId: string;
    sessionId: string;
    seed: Uint8Array;
    firstIndex: number;
    createdAt: number;
  }
): Promise<boolean> {
  const { storage, deviceKeyB64 } = requireGraineRuntime('cannot store an incoming seed');
  if (!seed.sessionId || seed.seed.length === 0 || !seed.channelId) {
    console.warn(
      `[GRAINE] ignoring a malformed seed frame from ${senderId} in community ${workspaceId.slice(0, 8)}`
    );
    return false;
  }

  const existing = await storage.getGraineSession(seed.sessionId, deviceKeyB64);
  if (existing) {
    // OUR OWN SESSION, COMING BACK. The frame is durable, so this device meets its own seed again
    // on every fresh start. Writing it would drop `sentCount` - the count that decides the next
    // index and the 100-message rotation - and the session would look received rather than minted,
    // so the next send would rotate for no reason and distribute a seed nobody needed.
    if (existing.sentCount !== undefined) return nowHeld(seed.sessionId);
    // A lower floor is strictly more history: same seed, more of it readable. Anything else is a
    // replay of what is already held.
    if (existing.firstIndex <= seed.firstIndex) return nowHeld(seed.sessionId);
  }

  const session: StoredGraineSession = {
    workspaceId,
    channelId: seed.channelId,
    sessionId: seed.sessionId,
    senderId: senderId.toLowerCase(),
    seedB64: toBase64(seed.seed),
    firstIndex: seed.firstIndex,
    createdAt: seed.createdAt || Date.now(),
    // Neither is ours to know. `sentCount` is what makes a session THIS device's outbound one, and
    // `distributionEpoch` is the roster it was minted under - a judgement only its sender may make.
  };
  await storage.saveGraineSession(session, deviceKeyB64);
  cacheGraineSession(session);
  // Mirrored so a push arriving with the app killed can still be opened. Not awaited for
  // correctness - the seed is already durable - but awaited for ORDER: a notification racing the
  // mirror would degrade for no reason.
  await mirrorGraineSeed(session);
  return nowHeld(seed.sessionId);
}

/**
 * Marks a session as held on every path that ends with this device holding it.
 *
 * A repair left armed for a seed that has arrived is not merely useless: the ask is what a later
 * miss on the same session has to get past, so leaving it in place would silence the one request
 * that could still widen a floor.
 */
function nowHeld(sessionId: string): true {
  forgetAskedSession(sessionId);
  return true;
}

/**
 * The handler wired into the MLS layer: decodes a distribution frame and acts on it.
 *
 * Every branch either does something or SAYS what it declined, because a seed silently dropped
 * surfaces weeks later as a salon whose history is unreadable with nothing to point at.
 */
export async function handleDistributionFrame(frame: DistributionFrame): Promise<void> {
  const msg = decodeAppMessage(frame.plaintext);
  if (!msg) {
    console.warn(
      `[GRAINE] undecodable frame on the distribution group of ${frame.workspaceId.slice(0, 8)} from ${frame.sender}`
    );
    return;
  }

  if (msg.graine) {
    const stored = await storeIncomingSeed(frame.workspaceId, frame.sender, {
      channelId: String(msg.graine.channelId ?? ''),
      sessionId: String(msg.graine.sessionId ?? ''),
      seed: msg.graine.seed instanceof Uint8Array ? msg.graine.seed : new Uint8Array(),
      firstIndex: Number(msg.graine.firstIndex) || 0,
      createdAt: Number(msg.graine.createdAt) || 0,
    });
    if (stored) {
      console.debug(
        `[GRAINE] seed ${msg.graine.sessionId} from ${frame.sender} for channel ${String(msg.graine.channelId).slice(0, 8)}`
      );
      // ANNOUNCED HERE TOO, not only from a repair bundle. A seed reaches a device by two paths -
      // the sender distributing it, and the distribution group's durable log replaying it on
      // reconnect - and only the second one races the salon's own history load. Losing that race
      // rendered rows unreadable and dropped them, and until this line nothing went back for them:
      // a device that reconnected into an open salon sat in front of a blank history it already
      // held the seed for.
      announceGraineRepair([String(msg.graine.channelId ?? '')].filter(Boolean));
    }
    return;
  }

  if (msg.graineRequest) {
    await answerSeedRequest(frame, msg.graineRequest);
    return;
  }

  if (msg.graineBundle) {
    await absorbSeedBundle(frame, msg.graineBundle);
    return;
  }

  // Reaching here means a peer is speaking a protocol this bundle does not answer, which is a
  // version skew worth naming rather than a silence that reads as "nothing arrived".
  console.warn(
    `[GRAINE] distribution frame of kind '${msg.kind ?? 'unknown'}' from ${frame.sender} is not handled by this client`
  );
}

/**
 * Answers a seed request - but only the one addressed to THIS device's user.
 *
 * Every member of the community receives the frame, and every member but one must ignore it. The
 * requester names its answerer precisely so that a salon of three hundred does not pay three
 * hundred bundles for one missing session.
 */
async function answerSeedRequest(
  frame: DistributionFrame,
  request: canari.GraineRequestMsg.$Properties
): Promise<void> {
  const { storage, deviceKeyB64, userId, mlsService } = requireGraineRuntime(
    'cannot answer a seed request'
  );
  if (String(request.answererUserId ?? '').toLowerCase() !== userId) return;

  const kinds = canariRuntime.GraineRequestKind;
  if (
    request.kind !== kinds.GRAINE_REQUEST_KIND_SESSIONS &&
    request.kind !== kinds.GRAINE_REQUEST_KIND_HISTORY
  ) {
    // UNSPECIFIED is declined and logged, never guessed at: "repair these" and "send me
    // everything" would otherwise be one message with an empty field.
    console.warn(
      `[GRAINE] declining a request of kind ${request.kind} from ${frame.sender} - only SESSIONS and HISTORY are answered here`
    );
    return;
  }

  const gathered =
    request.kind === kinds.GRAINE_REQUEST_KIND_HISTORY
      ? await gatherCommunityHistory(frame, storage, deviceKeyB64)
      : await gatherNamedSessions(frame, request, storage, deviceKeyB64);
  // A refusal (`null`, the past withheld) is the only case answered by silence, and it is the one
  // the requester can already derive: the visibility rule is broadcast by the server, so both sides
  // know it. Everything else answers, INCLUDING an empty hand - "I hold none of these" is the fact
  // that sends the requester to the next member, and withholding it strands the session for good.
  if (!gathered) return;
  if (gathered.seeds.length === 0 && gathered.missing.length === 0) return;

  const bundle = encodeAppMessage(
    mkGraineBundle({
      workspaceId: frame.workspaceId,
      requestId: String(request.requestId ?? ''),
      seeds: gathered.seeds,
      missingSessionIds: gathered.missing,
      // Stated rather than left to be inferred from a short list: "this is all there is" and "this
      // is all I could send" are different facts, and only one of them means ask again.
      truncated: gathered.truncated,
    })
  );
  const seeds = gathered.seeds;
  // A bundle CARRYING SEEDS is key material on a key-distribution group, and travels as such. It
  // was `DELIVERY.transport` until 2026-08-25, when COMM-18 measured what that costs: a device
  // that cold-starts has authenticated HTTP long before it has a socket, so it can ask - and did,
  // and landed a commit and published a GroupInfo in the same seconds - while presence truthfully
  // reports no socket for it. A transport-only frame is dropped for a recipient presence reports
  // offline, so the ANSWER to a request that had just arrived was discarded, permanently.
  // The classification, not the presence read, was the error. `DELIVERY.transport`'s argument is
  // that reconciliation traffic only restates state held elsewhere, so replaying it from the log
  // would be circular - true of a REQUEST, and false of the seed itself. `DELIVERY.keyMaterial`
  // exists for exactly this payload on exactly this group, and `seedDistribution` already sends
  // the ordinary distribution of it that way; only the answer to an ask did not.
  // A bundle of pure declines stays transport: it carries no seed, it does restate a fact both
  // sides can derive, and the capped log of a distribution group is spent on seeds alone.
  const delivery = seeds.length > 0 ? DELIVERY.keyMaterial : DELIVERY.transport;
  await mlsService.sendMessage(frame.groupId, bundle, undefined, delivery);
  console.info(
    `[GRAINE] answered ${frame.sender} with ${seeds.length} seed(s)` +
      (gathered.missing.length > 0 ? `, declining ${gathered.missing.length}` : '') +
      // Named in the line because it decides whether this answer survives a requester with no
      // socket, and a run log that omits it cannot tell a drop from a silence.
      ` as ${delivery.durable ? 'key material' : 'transport'}`
  );
}

/** Seeds ready to travel, what was asked for and not held, and whether more were held than fits. */
interface GatheredSeeds {
  seeds: canari.GraineMsg.$Properties[];
  /** Sessions the request named that this device does not hold. Travels, rather than being logged. */
  missing: string[];
  truncated: boolean;
}

/** Turns a held session into its wire form. */
function toWireSeed(held: StoredGraineSession): canari.GraineMsg.$Properties {
  return {
    channelId: held.channelId,
    sessionId: held.sessionId,
    seed: fromBase64(held.seedB64),
    // The floor travels as ours: a member cannot hand over more than they were given themselves,
    // and raising it here is what stops a repair from widening access.
    firstIndex: held.firstIndex,
    createdAt: held.createdAt,
  };
}

/**
 * The seeds named by a SESSIONS request, and what this device turned out not to hold.
 *
 * **Gated by the community's history rule, exactly like the join-time bundle.** A repair request
 * names sessions by id and asks for nothing else, so without this a community set to `joined`
 * refused the bundle and then handed the same past over one id at a time - which is what a
 * newcomer's device asks for the moment it renders a salon it cannot read.
 *
 * **The gate is a FLOOR, not a yes or a no**, because a session can span the member's arrival:
 * {@link historyFloorsFor} carries the reason and the asymmetry that produces it. A seed that may be
 * given only in part travels with `firstIndex` raised, which is the field that exists for exactly
 * that; one with nothing readable in it is not sent at all.
 *
 * A seed withheld here is absent from BOTH lists, and that is deliberate. Reporting it as `missing`
 * would be a lie with a cost: `missing` means "elect somebody else", and every other member applies
 * the same rule, so the requester would walk the whole roster to arrive at the answer it was given
 * first. Silence on those ids is the honest shape - the requester already knows the rule.
 *
 * @returns `null` when nothing may be handed over at all, which the caller answers with silence.
 */
async function gatherNamedSessions(
  frame: DistributionFrame,
  request: canari.GraineRequestMsg.$Properties,
  storage: IStorage,
  deviceKeyB64: string
): Promise<GatheredSeeds | null> {
  const wanted = (request.sessionIds ?? []).map(String).filter(Boolean);
  const truncated = wanted.length > GRAINE_HISTORY_BUNDLE_MAX_SEEDS;

  const held: StoredGraineSession[] = [];
  const missing: string[] = [];
  for (const sessionId of wanted.slice(0, GRAINE_HISTORY_BUNDLE_MAX_SEEDS)) {
    const session = await storage.getGraineSession(sessionId, deviceKeyB64);
    if (!session) {
      missing.push(sessionId);
      continue;
    }
    held.push(session);
  }

  if (missing.length > 0) {
    // Named rather than counted: this device was chosen as the holder and turned out not to be,
    // which is either a roster that moved under the requester or a seed lost on this side. The list
    // also TRAVELS, in the bundle, so the requester can elect somebody else instead of waiting on an
    // answer that is never coming.
    console.warn(
      `[GRAINE] asked for ${wanted.length} seed(s) by ${frame.sender}, holding ${held.length} - missing ${missing.join(', ')}`
    );
  }

  if (historyVisibilityFor(frame.workspaceId) === 'shared') {
    return { seeds: held.map(toWireSeed), missing, truncated };
  }

  let floors: Map<string, number>;
  try {
    floors = await historyFloorsFor(held, frame.sender);
  } catch (e) {
    // Fail-closed, and said out loud: this device cannot place the boundary, so it hands over
    // nothing. The other symptom is a member whose repairs silently stop working, which no log
    // would ever name.
    console.warn(
      `[GRAINE] refusing ${frame.sender} the seed(s) they asked for in community ` +
        `${frame.workspaceId.slice(0, 8)} - cannot place their history boundary: ` +
        (e instanceof Error ? e.message : String(e))
    );
    return null;
  }

  const seeds: canari.GraineMsg.$Properties[] = [];
  const withheld: string[] = [];
  for (const session of held) {
    const floor = floors.get(session.sessionId);
    if (floor === undefined) {
      withheld.push(session.sessionId);
      continue;
    }
    // RAISED, NEVER LOWERED. Our own floor is what we were given ourselves, and a repair that
    // widened access would be the leak this whole path exists to close.
    seeds.push(toWireSeed({ ...session, firstIndex: Math.max(session.firstIndex, floor) }));
  }

  if (withheld.length > 0) {
    // A decision rather than a loss, so it is logged like the bundle's refusal is. An honest client
    // never asks for these - it applies the same rule before sending the request - so a line here
    // names either a client that has not learned the rule yet or one that is not applying it.
    console.info(
      `[GRAINE] withholding ${withheld.length} seed(s) from ${frame.sender}: community ` +
        `${frame.workspaceId.slice(0, 8)} is set to 'joined' and they hold nothing that member may read`
    );
  }
  return { seeds, missing, truncated };
}

/**
 * Everything this device holds for the community - a joiner's catch-up, gated by the community's
 * history rule (WP-34).
 *
 * **The rule is enforced by the MEMBERS**, because a device about to hand a seed over is the only
 * place it can be: the server stores the setting and broadcasts it, holds no key, and could not
 * enforce it if it wanted to. This is one of the two places a seed leaves - {@link
 * gatherNamedSessions} is the other, and for a year it was not gated, which handed back one id at a
 * time exactly the past refused here.
 *
 * Refusing is not a silence: `joined` means the joiner reads from their arrival onwards, which is
 * the setting working, so it is logged as a decision rather than left to look like a lost frame.
 */
async function gatherCommunityHistory(
  frame: DistributionFrame,
  storage: IStorage,
  deviceKeyB64: string
): Promise<GatheredSeeds | null> {
  if (historyVisibilityFor(frame.workspaceId) === 'joined') {
    console.info(
      `[GRAINE] not sending history to ${frame.sender}: community ${frame.workspaceId.slice(0, 8)} is set to 'joined'`
    );
    return null;
  }

  const held = await storage.getGraineSessionsForWorkspace(frame.workspaceId, deviceKeyB64);
  const seeds = held.slice(0, GRAINE_HISTORY_BUNDLE_MAX_SEEDS).map(toWireSeed);
  console.info(
    `[GRAINE] sending ${seeds.length} of ${held.length} held seed(s) as history to ${frame.sender}`
  );
  // A history request names no session, so there is nothing it could have named and missed.
  return { seeds, missing: [], truncated: held.length > GRAINE_HISTORY_BUNDLE_MAX_SEEDS };
}

/** Stores the seeds of an answer and tells the UI which salons just became readable. */
async function absorbSeedBundle(
  frame: DistributionFrame,
  bundle: canari.GraineBundleMsg.$Properties
): Promise<void> {
  const repaired = new Set<string>();
  let absorbed = 0;
  for (const seed of bundle.seeds ?? []) {
    const stored = await storeIncomingSeed(frame.workspaceId, frame.sender, {
      channelId: String(seed.channelId ?? ''),
      sessionId: String(seed.sessionId ?? ''),
      seed: seed.seed instanceof Uint8Array ? seed.seed : new Uint8Array(),
      firstIndex: Number(seed.firstIndex) || 0,
      createdAt: Number(seed.createdAt) || 0,
    });
    if (stored) {
      absorbed++;
      if (seed.channelId) repaired.add(String(seed.channelId));
    }
  }

  // THE REPAIR PATH IS THE ONE THAT MUST SPEAK, and until 2026-08-20 it was the only inbound seed
  // path that did not. The single-seed branch above announces what it stored; this one absorbed a
  // whole answer in silence, so a member granted access to a salon started reading it with nothing
  // in any log saying the seed had landed - and a repair that FAILED looked exactly the same. It
  // only ever runs because something was already missing, which is precisely why it is worth a line.
  //
  // Counted per SEED and the salons named: "answered with N seed(s)" upstream against "absorbed 0"
  // here is the shape of an answer whose seeds were all refused, and nothing else would show it.
  console.debug(
    `[GRAINE] absorbed ${absorbed}/${(bundle.seeds ?? []).length} seed(s) from ${frame.sender} in community ${frame.workspaceId.slice(0, 8)} - salon(s) ${[...repaired].map((id) => id.slice(0, 8)).join(', ') || 'none'}`
  );

  if (bundle.truncated) {
    console.warn(
      `[GRAINE] ${frame.sender} sent a TRUNCATED bundle for community ${frame.workspaceId.slice(0, 8)} - some seeds are still missing`
    );
  }

  // What the answerer turned out not to hold. Each one re-elects the next member of the roster, so
  // an unlucky election costs a round trip instead of costing the session for the whole app session.
  for (const sessionId of bundle.missingSessionIds ?? []) {
    if (sessionId) noteSeedUnavailable(String(sessionId), frame.sender);
  }

  // The rows this repairs were rendered unreadable and dropped minutes ago; nothing else would go
  // back for them before the user next leaves and re-enters the salon.
  announceGraineRepair([...repaired]);
}
