import type { DistributionFrame } from '$lib/mls-client/IMlsService';
import type { IStorage, StoredGraineSession } from '$lib/db/types';
import type { canari } from '$lib/proto/canari';
import { canari as canariRuntime } from '$lib/proto/canari';
import { decodeAppMessage, encodeAppMessage, mkGraineBundle } from '$lib/proto/codec';
import { addressedKeyMaterial } from '$lib/mls-client/frameDelivery';
import { GRAINE_HISTORY_BUNDLE_MAX_SEEDS } from '$lib/crypto/graineConstants';
import { toBase64 } from '$lib/utils/hex';
import {
  announceGraineRepair,
  cacheGraineSession,
  cachedGraineSession,
  awaitSalonListing,
  isCommunityListed,
  knownHistoryVisibility,
  rawChannelId,
  requireGraineRuntime,
  scopeForChannel,
  whenHistoryRuleKnown,
} from './runtime';
import { sameScope, scopeLabel, type DistributionScope } from '$lib/mls-client/distributionScope';
import { applyHistoryFloors, historyFloorsFor } from './historyBoundary';
import { pastPolicyFor } from './admissionGate';
import { parkAsk, parkAskUntilRuleKnown } from './parkedAsks';
import { mirrorGraineSeed } from './graineMirror';
import {
  forgetAskedSession,
  noteHistoryAnswered,
  noteHistoryHeldNothing,
  noteSeedUnavailable,
} from './repair';
import { seedFromWire, storedV2From, storedV2Of, toWireSeed, type IncomingSeed } from './wireSeed';
import { checkSeedEndorsement, type EndorsementSource } from './endorsement';
import { pageGraineBundle } from './bundlePages';
import { historyPageFault, noteHistoryPage } from './pagedHistoryAnswer';

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
 * What storing one incoming seed CHANGED, which is what decides whether a salon is re-read.
 *
 * `stored` - a new session, or a lower floor on a held one: rows that could not be read now can.
 * `already-held` - a copy of what this device holds; nothing new is readable.
 * `declined` - malformed, a replacement, or an endorsement that did not hold; nothing was stored.
 * `v1-refused` - a NEW v1 seed (section 21.7); nothing was stored. Apart from `declined` because its
 *   CALLER says it: an honest peer relays every v1 session it holds, so the refusal is said once per
 *   bundle, not once per seed. Never folded into `already-held`: it repairs nothing.
 * `out-of-scope` - a NEW seed of a salon whose key group is not the one it arrived on
 *   ({@link seedOutsideScope}); nothing was stored. Said by the caller, once per bundle, for the
 *   reason `v1-refused` is: one answer can carry many.
 * `awaiting-listing` - a NEW seed, on the community's group, of a salon the community's answered
 *   listing did not name: not stored, held in memory until a registration says whether the salon is
 *   public (`awaitSalonListing`).
 *
 * A boolean used to fold the first two together ("held, including when it already was"), and a seed
 * bundle travels on the community's distribution group, so EVERY member receives the answer to
 * ANY member's request. Each of them announced every salon named by a seed it already held as
 * repaired and re-read its history: 18 refetches of one salon in three minutes on a client that had
 * asked for nothing ([channel-encryption](docs/wiki/protocols/channel-encryption.md#the-repair-that-worked-said-nothing---fixed-2026-08-20)).
 */
export type SeedStoreOutcome =
  | 'stored'
  | 'already-held'
  | 'declined'
  | 'v1-refused'
  | 'out-of-scope'
  | 'awaiting-listing';

/**
 * What storing one incoming seed did, and - for a NEW v2 session - which key proved its endorsement.
 *
 * `endorsedBy` travels to the caller's own line rather than being said where it is verified: the
 * caller already speaks once per seed (a distributed seed) or once per bundle (an answer), and a
 * line per verification was the largest tag of a sign-in (496 on the Mi 9T, 2026-10-13).
 */
export interface SeedStoreResult {
  outcome: SeedStoreOutcome;
  /** Set only when this call admitted a new v2 session. */
  endorsedBy?: EndorsementSource;
  /** Set only on `out-of-scope`: which mismatch it was, which decides how loudly it is said. */
  outOfScope?: 'other-salon-group' | 'private-salon';
}

/**
 * Stores an incoming Graine seed, or explains why it was ignored.
 *
 * **A NEW v1 seed is refused** (channel-encryption section 21.7, user decision 2026-09-28): since
 * `minClientVersion` reached the v2 writer (`1.0.3`, raised 2026-10-11) no honest client mints one,
 * and a v1 seed names no minter, so a modified client could mint one to post under any member's
 * name. A v1 session ALREADY HELD stays held - its floor may still be lowered by a copy - and keeps
 * opening its rows until the v1 reader goes (`docs/wiki/legacy-compatibility.md`).
 *
 * **A NEW seed is admitted only on the key group of its salon** ({@link seedOutsideScope}): a
 * private salon's seed arriving on the community's group reached a roster that is not the salon's.
 * A session already held is not ARRIVING, so a copy of it is judged as before.
 *
 * @param keyGroupId The distribution group the frame arrived on - whose tree names a v2 minter.
 * @param scope The roster of that group.
 * @returns what storing it CHANGED - see {@link SeedStoreResult}.
 */
export async function storeIncomingSeed(
  workspaceId: string,
  senderId: string,
  seed: IncomingSeed,
  keyGroupId: string,
  scope: DistributionScope
): Promise<SeedStoreResult> {
  const { storage, deviceKey } = requireGraineRuntime('cannot store an incoming seed');
  if (!seed.sessionId || seed.seed.length === 0 || !seed.channelId) {
    console.warn(
      `[GRAINE] ignoring a malformed seed frame from ${senderId} in community ${workspaceId.slice(0, 8)}`
    );
    return { outcome: 'declined' };
  }

  // THE SEED CACHE FIRST, because the same held session arrives again and again: its durable
  // distribution frame on every fresh start, each bundle relaying it, each answer to a request. Every
  // arrival read and decrypted the row (`SELECT * FROM graine WHERE session_id`, 358 in a store
  // phone's first 30 s, 2026-10-13). The cache holds only ANSWERS and every write of a received
  // session goes through it (below), so a hit is the row; a miss still reads the store.
  let existing = cachedGraineSession(seed.sessionId);
  if (!existing) {
    existing = await storage.getGraineSession(seed.sessionId, deviceKey());
    if (existing) cacheGraineSession(existing);
  }
  if (existing) {
    // A SESSION ID NAMES ONE SEED, IN ONE SALON, FOR EVER. A frame naming a held session with other
    // bytes, or another salon, is not a repair - a repair re-sends the SAME seed at a lower floor.
    // It is somebody replacing a seed they did not mint, and accepting it would make every later
    // message of that session open under their key, attributed to its real sender. Checked BEFORE
    // the two "already held" exits below, so a replacement is refused out loud, never absorbed as a
    // harmless replay.
    const conflict = seedConflict(existing, workspaceId, seed);
    if (conflict) {
      console.error(
        `[GRAINE] REFUSED seed replacement: ${senderId} sent session ${seed.sessionId} with a different ${conflict} than the one held (from ${existing.senderId}) in community ${workspaceId.slice(0, 8)}`
      );
      return { outcome: 'declined' };
    }
    // OUR OWN SESSION, COMING BACK. The frame is durable, so this device meets its own seed again
    // on every fresh start. Writing it would drop `sentCount` - the count that decides the next
    // index and the 100-message rotation - and the session would look received rather than minted,
    // so the next send would rotate for no reason and distribute a seed nobody needed.
    if (existing.sentCount !== undefined)
      return { outcome: nowHeld(seed.sessionId, 'already-held') };
    // A lower floor is strictly more history: same seed, more of it readable. Anything else is a
    // replay of what is already held.
    if (existing.firstIndex <= seed.firstIndex)
      return { outcome: nowHeld(seed.sessionId, 'already-held') };
  }

  if (!existing) {
    const outside = seedOutsideScope(seed.channelId, scope);
    if (outside === 'other-salon-group' || outside === 'private-salon') {
      return { outcome: 'out-of-scope', outOfScope: outside };
    }
    if (outside === 'unlisted') {
      // Private and closed to this viewer, or public and created since the listing: only the
      // salon's registration can say which, so the seed waits for it, unstored.
      const waits = awaitSalonListing(workspaceId, seed.channelId, async () => {
        const { outcome } = await storeIncomingSeed(workspaceId, senderId, seed, keyGroupId, scope);
        if (outcome === 'stored') announceGraineRepair([String(seed.channelId)]);
      });
      return { outcome: waits ? 'awaiting-listing' : 'declined' };
    }
    // `not-listed-yet`: kept - see `seedOutsideScope`.
  }

  const admitted = existing
    ? // THE FLOOR IS THE ONLY THING A SECOND COPY MAY MOVE. Who the session is recorded under stays
      // who it was first recorded under: a repair bundle is sent by whoever ANSWERED, and writing
      // that answerer over the row would re-attribute a session to somebody who never minted it.
      { session: { ...existing, firstIndex: seed.firstIndex } }
    : await admitNewSession(workspaceId, senderId, seed, keyGroupId);
  if (admitted === null) return { outcome: 'declined' };
  if (admitted === 'v1-refused') return { outcome: 'v1-refused' };
  const { session } = admitted;
  const endorsedBy = 'endorsedBy' in admitted ? admitted.endorsedBy : undefined;
  await storage.saveGraineSession(session, deviceKey());
  cacheGraineSession(session);
  // Mirrored so a push arriving with the app killed can still be opened. Not awaited for
  // correctness - the seed is already durable - but awaited for ORDER: a notification racing the
  // mirror would degrade for no reason.
  await mirrorGraineSeed(session);
  return { outcome: nowHeld(seed.sessionId, 'stored'), endorsedBy };
}

/**
 * The stored form of a session this device does not hold yet, or why it may not be stored.
 *
 * **Only a v2 session is ever admitted.** A NEW v1 session is refused (section 21.7): after the
 * held-session exits on purpose, since a v1 session already held is not ARRIVING and a copy of it
 * may still lower its floor; and before anything is written, so a refused seed leaves nothing in the
 * store or the native mirror. Not logged here: the caller says it, once per frame or per bundle.
 *
 * **A new v2 session is admitted only once its minter's device is shown to have endorsed this key
 * and this seed** (section 21). `null` is a refused or unanswered endorsement, already logged; an
 * admitted session carries which key proved it, for the caller's line.
 */
async function admitNewSession(
  workspaceId: string,
  senderId: string,
  seed: IncomingSeed,
  keyGroupId: string
): Promise<{ session: StoredGraineSession; endorsedBy: EndorsementSource } | 'v1-refused' | null> {
  const v2 = seed.v2;
  if (!v2) return 'v1-refused';
  const { mlsService } = requireGraineRuntime('cannot admit an incoming seed');
  const verdict = await checkSeedEndorsement(mlsService, keyGroupId, seed);
  if (verdict.kind === 'refused') {
    console.error(
      `[GRAINE] REFUSED v2 seed ${seed.sessionId} from ${senderId} in community ${workspaceId.slice(0, 8)}: ${verdict.why}`
    );
    return null;
  }
  if (verdict.kind === 'unanswered') {
    // Not a refusal: nothing is known against the seed. Not stored either - a half-checked
    // session is what "never stored half" forbids - and a later row under it is a missing seed,
    // which asks again.
    console.warn(
      `[GRAINE] v2 seed ${seed.sessionId} from ${senderId} NOT stored yet: ${verdict.why}`
    );
    return null;
  }
  const session: StoredGraineSession = {
    workspaceId,
    channelId: seed.channelId,
    sessionId: seed.sessionId,
    // Recorded under the minter its endorsement NAMES - never the frame's sender, who on a relay is
    // whoever answered. Kept exactly as signed: the endorsement is verified over these bytes, and a
    // case-folded copy would stop matching them.
    senderId: v2.minterUserId,
    seedB64: toBase64(seed.seed),
    firstIndex: seed.firstIndex,
    createdAt: seed.createdAt || Date.now(),
    v2: storedV2From(v2),
    // Neither is ours to know. `sentCount` is what makes a session THIS device's outbound one,
    // and `distributionEpoch` is the roster it was minted under - a judgement only its sender
    // may make.
  };
  return { session, endorsedBy: verdict.source };
}

/**
 * What an incoming copy of a held session contradicts, or null when it is the same session.
 *
 * A session is one seed bound to one salon of one community, so any of the three differing means
 * the frame is not a copy of it at all.
 */
function seedConflict(
  held: StoredGraineSession,
  workspaceId: string,
  incoming: IncomingSeed
): 'seed' | 'salon' | 'community' | 'endorsement' | null {
  if (held.workspaceId !== workspaceId) return 'community';
  if (held.channelId !== incoming.channelId) return 'salon';
  if (held.seedB64 !== toBase64(incoming.seed)) return 'seed';
  // v2 is part of what a session IS: a copy that drops it, adds it, or names another minter or key
  // is a different session wearing a held id - the downgrade this field exists to make impossible.
  const incomingV2 = storedV2Of(incoming);
  if (
    held.v2?.endorsementB64 !== incomingV2?.endorsementB64 ||
    held.v2?.signingPublicKeyB64 !== incomingV2?.signingPublicKeyB64 ||
    held.v2?.minterDeviceId !== incomingV2?.minterDeviceId ||
    (incoming.v2 !== undefined && held.senderId !== incoming.v2.minterUserId)
  ) {
    return 'endorsement';
  }
  return null;
}

/**
 * Whether a salon's seed may travel on, or be taken from, the key group of `scope` - and if not,
 * why. Null when it may.
 *
 * **A seed belongs to the key group of its salon**: a private salon's own group, the community's
 * for a public one (`registerChannelWorkspace`, from the community listing). Seeds are STORED per
 * community whichever group they arrived on, so the store alone cannot say this; this does, and
 * both ends ask it - the answerer before a seed leaves, the receiver before a new one is kept.
 *
 * - `other-salon-group`: a private salon's own group, and another salon (needs no listing: the
 *   scope names its one salon). No honest path sends that.
 * - `private-salon`: the community's group, and a salon registered PRIVATE. An honest path exists -
 *   a salon made private keeps, in the community group's log, the seeds minted while it was public -
 *   so a receiver says it without accusing anybody.
 * - `unlisted`: the community's group, the community's listing HAS answered and did not name the
 *   salon. The listing names every public salon to every member, so the salon is private and closed
 *   to this viewer - or public and created since. The receiver holds the seed unstored until a
 *   registration decides ({@link storeIncomingSeed}).
 * - `not-listed-yet`: the community's group, and its listing has not answered yet. The RECEIVER
 *   keeps the seed: a public salon's seeds arrive with the key group, before the listing, and
 *   answerers filter at the source.
 *
 * The ANSWERER withholds every non-null answer: a seed whose roster it does not know is not one it
 * can place on a key group.
 */
function seedOutsideScope(
  channelId: string,
  scope: DistributionScope
): 'other-salon-group' | 'private-salon' | 'unlisted' | 'not-listed-yet' | null {
  const salon = rawChannelId(channelId);
  if (scope.kind === 'channel') return salon === scope.channelId ? null : 'other-salon-group';
  const known = scopeForChannel(salon);
  if (!known) return isCommunityListed(scope.workspaceId) ? 'unlisted' : 'not-listed-yet';
  return sameScope(known, scope) ? null : 'private-salon';
}

/**
 * The held sessions that may answer a request on the key group of `frame`, and ONE line naming
 * how many were withheld and why - counts and the scope only, never a session's material.
 */
function withinFrameScope(
  frame: DistributionFrame,
  held: StoredGraineSession[]
): StoredGraineSession[] {
  const kept: StoredGraineSession[] = [];
  let otherRoster = 0;
  let notListed = 0;
  for (const session of held) {
    const outside = seedOutsideScope(session.channelId, frame.scope);
    if (outside === null) kept.push(session);
    else if (outside === 'other-salon-group' || outside === 'private-salon') otherRoster++;
    else notListed++;
  }
  if (otherRoster + notListed > 0) {
    // A decision, so at info like the history rule's refusals: an answer carries only the seeds of
    // the salons the asker's key group may read.
    console.info(
      `[GRAINE] withholding ${otherRoster + notListed} seed(s) from ${frame.sender} on ${scopeLabel(frame.scope)}: ` +
        `${otherRoster} of a salon riding another key group, ${notListed} not listed on this device`
    );
  }
  return kept;
}

/** The stored-seed line's account of which key proved the endorsement, when one was checked. */
function endorsedNote(endorsedBy: EndorsementSource | undefined): string {
  if (!endorsedBy) return '';
  return endorsedBy === 'tree'
    ? ' - v2 endorsement verified from the tree'
    : " - v2 endorsement verified from the server's published keys (minter has left the tree)";
}

/**
 * Marks a session as held on every path that ends with this device holding it.
 *
 * A repair left armed for a seed that has arrived is not merely useless: the ask is what a later
 * miss on the same session has to get past, so leaving it in place would silence the one request
 * that could still widen a floor.
 */
function nowHeld<O extends 'stored' | 'already-held'>(sessionId: string, outcome: O): O {
  forgetAskedSession(sessionId);
  return outcome;
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
    const { outcome, endorsedBy, outOfScope } = await storeIncomingSeed(
      frame.workspaceId,
      frame.sender,
      seedFromWire(msg.graine),
      frame.groupId,
      frame.scope
    );
    const salon = String(msg.graine.channelId).slice(0, 8);
    if (outcome === 'out-of-scope' && outOfScope === 'other-salon-group') {
      // An ERROR: a private salon's key group carries that salon's seeds and nothing else, and no
      // honest sender has a reason to put another salon's seed on it.
      console.error(
        `[GRAINE] REFUSED seed ${msg.graine.sessionId} from ${frame.sender}: salon ${salon} is not the salon of ${scopeLabel(frame.scope)}`
      );
      return;
    }
    if (outcome === 'out-of-scope') {
      // A WARN, accusing nobody: a salon made private after it was public leaves, in the community
      // group's log, the seeds an honest sender minted while it was public - a device catching up
      // meets them here. Its readers fetch them again on the salon's own group.
      console.warn(
        `[GRAINE] not storing seed ${msg.graine.sessionId} from ${frame.sender}: salon ${salon} is private now, and its seeds ride its own key group, not ${scopeLabel(frame.scope)} (a seed minted before it became private, or a sender out of step)`
      );
      return;
    }
    if (outcome === 'awaiting-listing') {
      console.info(
        `[GRAINE] seed ${msg.graine.sessionId} from ${frame.sender} waits, unstored: salon ${salon} is not in ${scopeLabel(frame.scope)}'s listing - kept only if it is registered as public`
      );
      return;
    }
    if (outcome === 'v1-refused') {
      // A warn, not an ERROR: the distribution group's durable log still replays v1 frames an honest
      // client distributed before the floor moved, so this line alone accuses nobody. Its date is
      // the sender's claim and decides nothing; it is printed so a reader can tell an old replay
      // from a fresh mint.
      console.warn(
        `[GRAINE] REFUSED v1 seed ${msg.graine.sessionId} from ${frame.sender} in community ${frame.workspaceId.slice(0, 8)} (claimed createdAt ${String(msg.graine.createdAt ?? 0)}): a v1 seed is no longer accepted`
      );
      return;
    }
    if (outcome === 'already-held') {
      console.debug(
        `[GRAINE] seed ${msg.graine.sessionId} from ${frame.sender} already held - nothing to re-read`
      );
    }
    if (outcome === 'stored') {
      console.debug(
        `[GRAINE] seed ${msg.graine.sessionId} from ${frame.sender} for channel ${String(msg.graine.channelId).slice(0, 8)}` +
          endorsedNote(endorsedBy)
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
 * hundred bundles for one missing session - and, since 1.2.5, the DEVICES of that member that
 * answer, each answer going back to the one device that asked (channel-encryption section 23).
 */
async function answerSeedRequest(
  frame: DistributionFrame,
  request: canari.GraineRequestMsg.$Properties
): Promise<void> {
  const { storage, deviceKey, userId, mlsService } = requireGraineRuntime(
    'cannot answer a seed request'
  );
  if (String(request.answererUserId ?? '').toLowerCase() !== userId) return;
  // ONLY THE DEVICES THE REQUESTER NAMED ANSWER (section 23): those of this user it saw online AND
  // as leaves of its own tree. A device it did not name cannot be told apart from a device that never
  // received the request, so its answer would only duplicate. An empty list is a requester before
  // 1.2.5, or one whose roster had no per-device presence, and every device answers as it always did.
  const named = (request.answererDeviceIds ?? []).map(String);
  if (named.length > 0 && !named.includes(mlsService.getDeviceId())) {
    console.debug(
      `[GRAINE] not answering ${frame.sender}'s request ${String(request.requestId ?? '')} in community ` +
        `${frame.workspaceId.slice(0, 8)}: it names ${named.join(',')}, not this device - the requester ` +
        `saw it offline or outside the key group's tree`
    );
    return;
  }

  // THE ANSWER GOES TO THE DEVICE THAT ASKED, AND TO NOBODY ELSE. A request is transport, so it only
  // ever arrives live, and the live envelope always names its device: reaching here without one is a
  // broken invariant upstream, and answering the whole key group instead would be the very fan-out
  // this exists to end (section 23). Refused out loud; the requester asks again on its next start.
  if (!frame.senderDeviceId) {
    console.error(
      `[GRAINE] NOT answering ${frame.sender} in community ${frame.workspaceId.slice(0, 8)}: the request's envelope named no device, and an answer is addressed to the device that asked`
    );
    return;
  }
  const requester = `${frame.sender}:${frame.senderDeviceId}`;

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
      ? await gatherCommunityHistory(frame, storage, deviceKey())
      : await gatherNamedSessions(frame, request, storage, deviceKey());
  // `unobserved` is not a refusal (section 25): the asker's voucher waits for the community's key
  // group to drain on this device, and this ask may be that group's current frame - so it is parked,
  // never awaited here, and decided again by the drain.
  if (gathered === UNOBSERVED) {
    parkAsk(frame, request, answerSeedRequest);
    return;
  }
  // Nor is an unknown history rule: this session's listing has not stated it yet, and a floor drawn
  // under a guess would cost a `shared` past for good - so the ask waits for the rule, parked the
  // same way, and is decided again when the listing states it.
  if (gathered === RULE_UNKNOWN) {
    parkAskUntilRuleKnown(frame, request, answerSeedRequest);
    return;
  }
  // A refusal (`null`: the asker's floor could not be placed) is the only case answered by silence
  // - nothing may be handed over without it, and the requester asks again on its next start.
  // Everything else answers,
  // INCLUDING an empty hand - "I hold none of these" is the fact
  // that sends the requester to the next member, and withholding it strands the session for good.
  if (!gathered) return;
  // A HISTORY ask answered with an empty hand SAYS SO (section 24): silence there was the one answer
  // the requester could not record, so it asked again at every launch. Additive - a requester that
  // predates the field reads an empty bundle and does nothing with it. Only when the store holds NO
  // ROW of the community (`gatherCommunityHistory`): rows that would not decrypt are not "nothing",
  // and stay the silence they were. A SESSIONS ask never reaches this with an empty hand and nothing
  // declined unless every seed was withheld, which stays silent for the reason `gatherNamedSessions`
  // gives.
  const holdsNothing = gathered.holdsNothing === true && gathered.seeds.length === 0;
  if (!holdsNothing && gathered.seeds.length === 0 && gathered.missing.length === 0) return;

  // BOUNDED IN BYTES, NOT IN SEEDS (2026-10-22): an answer over GRAINE_BUNDLE_PAGE_MAX_BYTES goes as
  // several complete bundles under one request id. Each seed is stored on its own at the other end,
  // so the pages need no reassembly - see `bundlePages.ts` for why order and duplicates corrupt
  // nothing there, and what a lost page costs.
  const pages = pageGraineBundle({
    workspaceId: frame.workspaceId,
    requestId: String(request.requestId ?? ''),
    seeds: gathered.seeds,
    missing: gathered.missing,
    // Stated rather than left to be inferred from a short list: "this is all there is" and "this
    // is all I could send" are different facts, and only one of them means ask again.
    truncated: gathered.truncated,
    holdsNothing,
  });
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
  // A bundle of pure declines travels as key material TOO (user decision, 2026-10-10). It stayed
  // transport on the argument that it restates a fact the requester can derive, and that argument
  // is false for the one fact it carries: "I do not hold it" is what sends the requester to the
  // NEXT member, and a decline dropped for a recipient presence reports offline (a cold start asks
  // before it has a socket - the COMM-18 shape) strands the session for good, nothing re-asks. An
  // answer is ONE message whatever it carries, with one delivery. The cost is a few bytes in the
  // capped log; a decline replayed from it is idempotent (`noteSeedUnavailable` binds it to the
  // request it answers).
  //
  // ADDRESSED TO THE DEVICE THAT ASKED (section 23, 2026-10-12). Key material on the key group was
  // queued for every seat of it, offline ones included: on production a 112-seat community paid ~42
  // rows per bundle and bundles were 70 % of its queued bytes, for seeds nobody else had asked for.
  // Still durable for the requester - the COMM-18 reason above holds for it - and kept out of the
  // group's shared log, which every member reads.
  //
  // EVERY PAGE TRAVELS THE SAME WAY, in order, one after the other. A page that fails to send is
  // said with how many went before it and the failure propagates exactly as a one-message answer's
  // did; the pages already sent are stored at the other end, and what the rest carried is asked for
  // there one session at a time.
  for (const [index, page] of pages.entries()) {
    try {
      await mlsService.sendMessage(
        frame.groupId,
        encodeAppMessage(mkGraineBundle(page)),
        undefined,
        addressedKeyMaterial(requester)
      );
    } catch (e) {
      console.warn(
        `[GRAINE] page ${index + 1}/${pages.length} of the answer to ${requester} (request ${String(request.requestId ?? '')}) was not sent - ${index} page(s) went before it: ${String(e)}`
      );
      throw e;
    }
  }
  // An EMPTY answer ("I hold nothing of the community", no decline) is the routine outcome of every
  // join into a community with no history: it said nothing a reader could act on and came once per
  // member per device (25 lines in one measured row). The frame sent is the record of it; a line
  // is kept for an answer that CARRIED something - seeds or declines.
  if (seeds.length > 0 || gathered.missing.length > 0) {
    console.info(
      `[GRAINE] answered ${requester} with ${seeds.length} seed(s)` +
        (gathered.missing.length > 0 ? `, declining ${gathered.missing.length}` : '') +
        ` in ${pages.length} page(s)`
    );
  }
}

/** A gather the admission gate cannot decide until the key group drains - the ask is parked. */
const UNOBSERVED = Symbol('unobserved');

/** A gather that waits for this session to learn the community's history rule - parked too. */
const RULE_UNKNOWN = Symbol('rule-unknown');

/** A gather this device cannot decide yet - each one names the event the ask is parked for. */
type Undecided = typeof UNOBSERVED | typeof RULE_UNKNOWN;

function isUndecided(value: unknown): value is Undecided {
  return value === UNOBSERVED || value === RULE_UNKNOWN;
}

/** Seeds ready to travel, what was asked for and not held, and whether more were held than fits. */
interface GatheredSeeds {
  seeds: canari.GraineMsg.$Properties[];
  /** Sessions the request named that this device does not hold. Travels, rather than being logged. */
  missing: string[];
  truncated: boolean;
  /**
   * HISTORY only: the store holds no row of the community at all, decryptable or not - the one
   * fact an answer of "I hold nothing" may claim (section 24).
   */
  holdsNothing?: boolean;
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
 * @returns `null` when nothing may be handed over at all, which the caller answers with silence;
 *   {@link UNOBSERVED} or {@link RULE_UNKNOWN} when the ask waits for an event (parked).
 */
async function gatherNamedSessions(
  frame: DistributionFrame,
  request: canari.GraineRequestMsg.$Properties,
  storage: IStorage,
  deviceKeyB64: string
): Promise<GatheredSeeds | null | Undecided> {
  const wanted = (request.sessionIds ?? []).map(String).filter(Boolean);
  const truncated = wanted.length > GRAINE_HISTORY_BUNDLE_MAX_SEEDS;

  const found: StoredGraineSession[] = [];
  const missing: string[] = [];
  for (const sessionId of wanted.slice(0, GRAINE_HISTORY_BUNDLE_MAX_SEEDS)) {
    const session = await storage.getGraineSession(sessionId, deviceKeyB64);
    if (!session) {
      missing.push(sessionId);
      continue;
    }
    found.push(session);
  }

  if (missing.length > 0) {
    // Named rather than counted: this device was chosen as the holder and turned out not to be,
    // which is either a roster that moved under the requester or a seed lost on this side. The list
    // also TRAVELS, in the bundle, so the requester can elect somebody else instead of waiting on an
    // answer that is never coming.
    // "Holding" counts only what this key group may read: a held seed of another roster is not one
    // this answer can carry, and counting it would read as a seed lost on the way.
    const holding = found.filter((s) => seedOutsideScope(s.channelId, frame.scope) === null).length;
    console.warn(
      `[GRAINE] asked for ${wanted.length} seed(s) by ${frame.sender}, holding ${holding} this key group may read - missing ${missing.join(', ')}`
    );
  }

  // A session withheld for its salon's roster is absent from BOTH lists, for the reason a floored
  // one is: every honest member filters the same way, so "missing" would send the requester round
  // the whole roster.
  const share = await seedsTheAskerMayRead(frame, found, 'the seed(s) they asked for');
  if (share === null || isUndecided(share)) return share;
  return { seeds: share.seeds, missing, truncated };
}

/** What {@link seedsTheAskerMayRead} hands over, and what it had to work with. */
interface AskersShare {
  /** The seeds that travel, floors applied. */
  seeds: canari.GraineMsg.$Properties[];
  /** How many held sessions this key group may read - before the cap and the floors. */
  inScope: number;
  /**
   * How many held sessions were withheld for their salon's roster (`withinFrameScope`) - a salon
   * of another key group, or one this device has not listed YET. Never part of "nothing for you".
   */
  outOfScope: number;
  /** The policy that decided, or `null` when nothing was in scope and no policy was asked. */
  policy: 'shared' | 'joined' | null;
}

/**
 * Of `found`, the seeds the asking MEMBER may be handed, in wire form - THE ONE CHOKEPOINT both
 * answer paths go through ({@link gatherNamedSessions}, {@link gatherCommunityHistory}), so the
 * two paths a seed leaves by cannot disagree. In this order:
 *
 * 1. **the salon's roster** (`withinFrameScope`): only the salons of the key group the request
 *    arrived on. First, so neither the admission gate nor a floor is ever asked about a salon the
 *    asker may not read at all - and with nothing left in scope the answer goes at once, ungated:
 *    "I hold none of these" depends neither on the rule nor on the asker;
 * 2. **the cap** (`cap`, history only), on what this key group may read;
 * 3. **the community's rule, as this SESSION learned it** (`knownHistoryVisibility`). Not learned
 *    yet: {@link RULE_UNKNOWN} - the caller PARKS the ask until the listing states the rule
 *    (`parkAskUntilRuleKnown`), never a floor. The fail-closed `joined` of `historyVisibilityFor` is
 *    a precaution where a seed would otherwise leave unfloored; here it would be a loss - a `shared`
 *    community's newcomer handed the floored past records the ask answered and never asks again;
 * 4. **THE GATE** (`pastPolicyFor`, channel-encryption section 25): `shared` only for an admission
 *    this device can verify; `joined` when the community is set to it, or the admission is not
 *    proven; `unverifiable` when it cannot be checked - SILENCE (`null`), never a floor, since a
 *    floored seed is lasting at the requester and a moment's failure must not be; `unobserved` ({@link UNOBSERVED})
 *    when a voucher waits for the key group to drain - the caller parks the ask;
 * 5. **under `joined`, the MEMBER's floor** - the community's setting or an unproven admission: each seed raised to the
 *    floor the server places at the asking member's arrival (`channel_members.createdAt`), a session
 *    with nothing readable for them withheld whole. The member's, never the device's: a new device of
 *    a member who has been in the community for a year is entitled to that year, and an unproven
 *    newcomer reads from their arrival on (section 25: "never refused whole").
 *
 * A withheld seed is a decision, logged at info. On a repair an honest requester never asks for one
 * (it applies the same rule before asking), so a line there names a client that has not learned the
 * rule or is not applying it; on a history bundle it is the ordinary pre-arrival past.
 *
 * @param cap At most this many in-scope sessions are considered (the history bundle's bound).
 * @returns `null` when the admission or the floors cannot be established - said, and answered by
 *   the caller with silence; {@link UNOBSERVED} or {@link RULE_UNKNOWN} when the ask must wait for an event.
 */
async function seedsTheAskerMayRead(
  frame: DistributionFrame,
  found: StoredGraineSession[],
  what: string,
  cap = Number.POSITIVE_INFINITY
): Promise<AskersShare | null | Undecided> {
  const inScope = withinFrameScope(frame, found);
  const outOfScope = found.length - inScope.length;
  // NEWEST FIRST, then the cap: the store's read has no order, and a cap on an arbitrary slice could
  // keep only sessions that predate a `joined` asker's arrival - an empty, truncated answer, the same
  // at every ask. The newest sessions are the ones a recent arrival may read.
  const held =
    inScope.length > cap
      ? [...inScope].sort((a, b) => b.createdAt - a.createdAt).slice(0, cap)
      : inScope;
  if (held.length === 0) {
    return { seeds: [], inScope: inScope.length, outOfScope, policy: null };
  }

  if (knownHistoryVisibility(frame.workspaceId) === null) {
    console.info(
      `[GRAINE] not answering ${frame.sender} ${what} in community ${frame.workspaceId.slice(0, 8)} yet: ` +
        `this session has not learned its history rule, and a floor drawn without it could cost a past for good`
    );
    return RULE_UNKNOWN;
  }

  const decision = await pastPolicyFor(frame);
  if (decision === 'unobserved') return UNOBSERVED;
  if (decision === 'shared') {
    return {
      seeds: held.map(toWireSeed),
      inScope: inScope.length,
      outOfScope,
      policy: 'shared',
    };
  }
  // AN ADMISSION THAT COULD NOT BE CHECKED IS ANSWERED BY SILENCE, on both paths - never floored.
  // A floored seed is lasting at the requester: the rows below its floor are classed "before this
  // device was given the seed" and asked of nobody, so a passing read failure would cost a member
  // who would have been proven part of a session for good. Silence costs a re-ask at the
  // requester's next start, and records nothing. The gate already said why, at warn.
  if (decision === 'unverifiable') return null;

  let floors: Map<string, number>;
  try {
    floors = await historyFloorsFor(held, frame.sender);
  } catch (e) {
    // Fail-closed, and said out loud: this device cannot place the boundary, so it hands over
    // nothing. The other symptom is a member whose repairs silently stop working, which no log
    // would ever name.
    console.warn(
      `[GRAINE] refusing ${frame.sender} ${what} in community ` +
        `${frame.workspaceId.slice(0, 8)} - cannot place their history boundary: ` +
        String(e)
    );
    return null;
  }

  const { kept, withheld } = applyHistoryFloors(held, floors);
  if (withheld.length > 0) {
    console.info(
      `[GRAINE] withholding ${withheld.length} of ${held.length} seed(s) from ${frame.sender}: community ` +
        `${frame.workspaceId.slice(0, 8)} is answered as 'joined' and they hold nothing that member may read`
    );
  }
  return {
    seeds: kept.map(toWireSeed),
    inScope: inScope.length,
    outOfScope,
    policy: 'joined',
  };
}

/**
 * Everything this device holds for the community that the asking member may read - a joiner's
 * catch-up, or a new device's, through {@link seedsTheAskerMayRead} (WP-34, section 25).
 *
 * **The rule is enforced by the MEMBERS**, because a device about to hand a seed over is the only
 * place it can be: the server stores the setting and broadcasts it, holds no key, and could not
 * enforce it if it wanted to.
 *
 * **Under `joined` this ANSWERS, floored, and never refuses whole** (2026-10-22). The refusal was a
 * reading of the rule by DEVICE: a member's new phone asked, was refused, and saw nothing of the
 * year it had been in the community, although the repair path would hand the same seeds over one
 * session id at a time. The same holds for a `joined` the admission gate decided (section 25): an
 * unproven newcomer reads from their arrival on. The cap applies to what this key group may read and
 * BEFORE the floors, so the bundle's size is bounded exactly as under `shared`.
 *
 * @returns `null` (silence) and {@link UNOBSERVED} (parked) as {@link seedsTheAskerMayRead} says.
 */
async function gatherCommunityHistory(
  frame: DistributionFrame,
  storage: IStorage,
  deviceKeyB64: string
): Promise<GatheredSeeds | null | Undecided> {
  // The store answers per COMMUNITY, private salons included; the answer goes back on the key group
  // the request arrived on, so it carries only that group's salons (`seedsTheAskerMayRead`).
  const held = await storage.getGraineSessionsForWorkspace(frame.workspaceId, deviceKeyB64);
  const share = await seedsTheAskerMayRead(
    frame,
    held,
    'the history they asked for',
    GRAINE_HISTORY_BUNDLE_MAX_SEEDS
  );
  if (share === null || isUndecided(share)) return share;
  const { seeds, inScope, outOfScope, policy } = share;
  const truncated = inScope > GRAINE_HISTORY_BUNDLE_MAX_SEEDS;
  // Said only when there WAS a past in scope: `0 of 0` is a fresh community's every join, once per
  // member per device, and states nothing (an empty hand over a non-empty scope still speaks).
  if (inScope > 0) {
    console.info(
      `[GRAINE] sending ${seeds.length} of ${inScope} seed(s) this key group may read as history to ${frame.sender}` +
        (policy === 'joined' ? ", floored at that member's arrival" : '')
    );
  }
  // "I HOLD NOTHING" IS A CLAIM ABOUT THE STORE, NOT ABOUT THIS KEY (section 24). The read above skips
  // a row it cannot decrypt - a PIN change re-sealing, a backup row sealed under another key - and
  // an empty list from it would put a durable "nothing" at the requester while the past sits here.
  // So the claim is made from the ROW count, read after the seeds so a row landing in between can
  // only withhold the claim, never make it. Rows present and not all opened answer as before:
  // silence. Under `joined`, an empty hand whose every row opened and was withheld by the floor
  // makes the same claim - "nothing here for you" - which the requester records exactly as it
  // records "nothing": that member's devices are done at this roster, and a row the member meets
  // later still asks its own session's sender.
  // NOT when a row was withheld for its salon's ROSTER: a salon this device has not listed yet may
  // turn out to be the asker's, and a durable "nothing" would close that past for the roster. NOR
  // when the cap cut the list: the floors judged only the first sessions, and the rest may be the
  // asker's. (An admission the gate could not check never reaches here: it is answered by silence.)
  let holdsNothing = false;
  if (seeds.length === 0) {
    const rows = await storage.countGraineSessionsForWorkspace(frame.workspaceId);
    holdsNothing = rows === held.length && outOfScope === 0 && !truncated;
    if (rows !== held.length) {
      console.warn(
        `[GRAINE] not answering ${frame.sender}'s history ask in community ${frame.workspaceId.slice(0, 8)}: ` +
          `${rows} seed row(s) held and ${rows - held.length} do not open with this device's key - not "I hold nothing"`
      );
    } else if (!holdsNothing) {
      const why = [
        outOfScope > 0 ? `${outOfScope} seed(s) withheld for their salon's roster` : null,
        truncated ? `more than ${GRAINE_HISTORY_BUNDLE_MAX_SEEDS} seed(s) in scope` : null,
      ].filter((reason): reason is string => reason !== null);
      console.info(
        `[GRAINE] not answering ${frame.sender}'s history ask in community ${frame.workspaceId.slice(0, 8)}: ` +
          `${why.join(', ')} - not "I hold nothing"`
      );
    }
  }
  // A history request names no session, so there is nothing it could have named and missed.
  return { seeds, missing: [], truncated, holdsNothing };
}

/**
 * Of the seeds a bundle carries, the ones THIS member may keep - the receiver's half of `joined`.
 *
 * **Why the receiver checks at all, when the answerer already floored the bundle.** A bundle is
 * floored for the member who ASKED, answerers before 1.2.6 addressed it to the whole key group
 * (channel-encryption section 23), and a floor drawn for somebody else is not this member's. So
 * under `joined` the bundle's seeds are re-floored here, at this member's own arrival, through the
 * same server route and the same raise-never-lower rule as the answerer.
 *
 * **The COMMUNITY's rule decides here, never the admission gate.** The gate (section 25) is about
 * whom an answerer may hand the past to; this member is proven to itself, so under `shared` it keeps
 * what it is handed - the answerer already floored an unproven asker.
 *
 * The frame carries nothing the receiver could check its addressing by - addressing is the
 * delivery service's - and the request id would refuse a legitimate late answer (section 23: a
 * struck member's late seed still lands). The floor is the check that cannot be wrong either way.
 *
 * Called with the seeds of LISTED salons of this key group only ({@link seedsWeMayFloor}): a floor
 * is asked of the server per salon, and one salon the server refuses us would fail the whole bundle.
 *
 * @returns The seeds to store, floors applied - none at all when the floors cannot be placed
 *   (fail-closed, said at warn): every seed refused here is still reachable by the repair path, one
 *   session at a time, which floors it at the answerer.
 */
async function seedsWeMayKeep(
  frame: DistributionFrame,
  seeds: IncomingSeed[]
): Promise<IncomingSeed[]> {
  if (seeds.length === 0) return seeds;
  const { userId } = requireGraineRuntime('cannot place our own history boundary');
  let floors: Map<string, number>;
  try {
    floors = await historyFloorsFor(seeds, userId);
  } catch (e) {
    console.warn(
      `[GRAINE] NOT absorbing ${seeds.length} seed(s) from ${frame.sender} in community ` +
        `${frame.workspaceId.slice(0, 8)}: it is set to 'joined' and our own history boundary ` +
        `cannot be placed - ${String(e)}`
    );
    return [];
  }
  const { kept, withheld } = applyHistoryFloors(seeds, floors);
  const sentAt = new Map(seeds.map((s) => [s.sessionId, s.firstIndex]));
  const raised = kept.filter((seed) => seed.firstIndex !== sentAt.get(seed.sessionId)).length;
  if (withheld.length > 0 || raised > 0) {
    // An answer floored for somebody else - an older answerer's broadcast - or a modified one. The
    // seeds are dropped or raised, and the line says how many, never which device sent the bundle
    // to whom: this device cannot know.
    console.info(
      `[GRAINE] a bundle from ${frame.sender} in community ${frame.workspaceId.slice(0, 8)} carried ` +
        `${withheld.length} seed(s) entirely before our arrival and ${raised} below it - ` +
        `withheld and raised to our own floor ('joined')`
    );
  }
  return kept;
}

/**
 * Under `joined`, which of a bundle's seeds a floor can be asked for - the receiver's scope check,
 * made BEFORE {@link seedsWeMayKeep}, with the one predicate both ends use ({@link seedOutsideScope}).
 *
 * - in scope (a listed salon of this key group): floored;
 * - another roster (`other-salon-group`, `private-salon`): refused, as `storeIncomingSeed` refuses a
 *   new one - and a held one is not re-floored through a salon's question this group cannot ask;
 * - not listed (`unlisted`, `not-listed-yet`): SET ASIDE, unstored. Under `shared` such a seed waits
 *   for its salon's registration (`awaitSalonListing`) or is kept, but a seed admitted that way is
 *   stored unfloored, and its floor cannot be asked now - a private salon we are not in is refused
 *   by the server, failing the whole bundle. Set aside, not lost: a salon this device renders later
 *   asks its own sessions by the repair path, floored at the answerer.
 */
function seedsWeMayFloor(
  frame: DistributionFrame,
  seeds: IncomingSeed[]
): { listed: IncomingSeed[]; otherRoster: string[]; notListed: number } {
  const listed: IncomingSeed[] = [];
  const otherRoster: string[] = [];
  let notListed = 0;
  for (const seed of seeds) {
    const outside = seedOutsideScope(seed.channelId, frame.scope);
    if (outside === null) listed.push(seed);
    else if (outside === 'other-salon-group' || outside === 'private-salon') {
      otherRoster.push(seed.sessionId);
    } else notListed++;
  }
  if (notListed > 0) {
    console.info(
      `[GRAINE] setting aside ${notListed} seed(s) from ${frame.sender} in community ${frame.workspaceId.slice(0, 8)}: ` +
        `their salon is not listed on this device and the community is set to 'joined', so no floor can be placed for them`
    );
  }
  return { listed, otherRoster, notListed };
}

/**
 * Where a bundle sits in its answer, for the absorb line: empty for an answer of one message, and
 * `page 2/5 of request r` otherwise. Every seed is stored on its own, so a page needs nothing from
 * the others: a numbering that cannot be true ({@link historyPageFault}) is said HERE, once, and the
 * page still absorbed - but never counted toward this device's history answer (`noteHistoryPage`).
 */
function pageNote(frame: DistributionFrame, bundle: canari.GraineBundleMsg.$Properties): string {
  const count = Number(bundle.pageCount ?? 0);
  if (count === 0) return '';
  const index = Number(bundle.pageIndex ?? 0);
  const fault = historyPageFault(index, count);
  if (fault !== null) {
    console.warn(
      `[GRAINE] ${frame.sender} numbered a bundle for request ${String(bundle.requestId ?? '')} in community ${frame.workspaceId.slice(0, 8)} with ${fault} - a numbering no answerer writes; its seeds are absorbed like any others, the page is not counted`
    );
  }
  return ` - page ${index + 1}/${count} of request ${String(bundle.requestId ?? '')}`;
}

/**
 * Stores the seeds of an answer - or of one PAGE of it - and tells the UI which salons just became
 * readable. A page is a complete bundle: nothing here waits for, counts or assembles the others.
 *
 * **A bundle carrying seeds WAITS for the community's history rule** when this session has not
 * learned it ({@link whenHistoryRuleKnown}): kept whole it could be a past the community closed,
 * floored it could be a past lost for good - a floored seed of a `shared` community classes the rows
 * below it as sent before this device was given the seed, and asks nobody for them. Under `joined`
 * the seeds are scoped ({@link seedsWeMayFloor}) then re-floored ({@link seedsWeMayKeep}); under
 * `shared` each one goes to `storeIncomingSeed` as it is. A held page is numbered and recorded
 * (`noteHistoryPage`) only when it is absorbed, after the wait.
 */
async function absorbSeedBundle(
  frame: DistributionFrame,
  bundle: canari.GraineBundleMsg.$Properties
): Promise<void> {
  const carried = (bundle.seeds ?? []).map(seedFromWire);
  const rule = knownHistoryVisibility(frame.workspaceId);
  if (rule === null && carried.length > 0) {
    const waits = whenHistoryRuleKnown(frame.workspaceId, () => {
      absorbSeedBundle(frame, bundle).catch((e: unknown) => {
        console.warn(
          `[GRAINE] the bundle from ${frame.sender} held for community ${frame.workspaceId.slice(0, 8)}'s history rule failed: ${String(e)}`
        );
      });
    });
    if (waits) {
      console.info(
        `[GRAINE] holding a bundle of ${carried.length} seed(s) from ${frame.sender} in community ` +
          `${frame.workspaceId.slice(0, 8)} until its history rule is known`
      );
    } else {
      // Its seeds are not lost to the community: each row they open asks its own session by the
      // repair path once the rule is known.
      console.warn(
        `[GRAINE] DROPPED a bundle of ${carried.length} seed(s) from ${frame.sender} in community ` +
          `${frame.workspaceId.slice(0, 8)}: too many steps already wait for a history rule`
      );
    }
    return;
  }
  // After the wait, never before it: a held bundle re-enters here, and its numbering is said once.
  const page = pageNote(frame, bundle);
  const repaired = new Set<string>();
  const refusedV1: string[] = [];
  const refusedOutOfScope: string[] = [];
  let awaitingListing = 0;
  // Scope BEFORE the floor under `joined`: a floor is asked per salon, and a salon of another roster
  // must never reach that question. The rule is unknown here only for a pure decline (no seed).
  let toStore = carried;
  if (rule === 'joined') {
    const { listed, otherRoster } = seedsWeMayFloor(frame, carried);
    refusedOutOfScope.push(...otherRoster);
    toStore = await seedsWeMayKeep(frame, listed);
  }
  let absorbed = 0;
  let alreadyHeld = 0;
  let endorsedByServer = 0;
  for (const seed of toStore) {
    const { outcome, endorsedBy } = await storeIncomingSeed(
      frame.workspaceId,
      frame.sender,
      seed,
      frame.groupId,
      frame.scope
    );
    // ONLY WHAT IS NEW REPAIRS A SALON. The bundle reaches every member of the community, so a seed
    // already held is the common case - somebody else's request being answered - and re-reading a
    // salon for it was a history refetch on every online member, per answer.
    if (outcome === 'stored') {
      absorbed++;
      if (endorsedBy === 'server') endorsedByServer++;
      if (seed.channelId) repaired.add(String(seed.channelId));
    } else if (outcome === 'already-held') {
      alreadyHeld++;
    } else if (outcome === 'v1-refused') {
      refusedV1.push(String(seed.sessionId ?? ''));
    } else if (outcome === 'out-of-scope') {
      refusedOutOfScope.push(String(seed.sessionId ?? ''));
    } else if (outcome === 'awaiting-listing') {
      awaitingListing++;
    }
  }

  if (refusedOutOfScope.length + awaitingListing > 0) {
    // ONE line per bundle, at warn: one answer can carry many seeds, and only their ids are named.
    const why: string[] = [];
    if (refusedOutOfScope.length > 0) {
      why.push(
        `${refusedOutOfScope.length} REFUSED, their salon rides another key group (${refusedOutOfScope.slice(0, 3).join(', ')}${refusedOutOfScope.length > 3 ? ', ...' : ''})`
      );
    }
    if (awaitingListing > 0) {
      why.push(
        `${awaitingListing} waiting unstored for a salon the community's listing did not name`
      );
    }
    console.warn(
      `[GRAINE] not storing ${refusedOutOfScope.length + awaitingListing} seed(s) relayed by ${frame.sender} on ${scopeLabel(frame.scope)}: ${why.join('; ')}`
    );
  }

  // AFTER its seeds are stored, never before: a page recorded as arrived is a page whose seeds are
  // here, which is what an incomplete history answer is judged on at the next start (section 4.4).
  // A bundle answering anything but this device's history ask is ignored there.
  noteHistoryPage(
    requireGraineRuntime('cannot record a history page').userId,
    frame.workspaceId,
    String(bundle.requestId ?? ''),
    frame.sender,
    Number(bundle.pageIndex ?? 0),
    Number(bundle.pageCount ?? 0)
  );

  if (refusedV1.length > 0) {
    // ONE line per bundle: an honest answerer relays every v1 session it holds, so a joiner's
    // history bundle can carry dozens. Those rows stay unreadable here and are not asked for again
    // (`GraineV1SessionNotHeldError`).
    console.warn(
      `[GRAINE] REFUSED ${refusedV1.length} v1 seed(s) relayed by ${frame.sender} in community ${frame.workspaceId.slice(0, 8)} - a v1 seed is no longer accepted (${refusedV1.slice(0, 3).join(', ')}${refusedV1.length > 3 ? ', ...' : ''})`
    );
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
    `[GRAINE] absorbed ${absorbed}/${(bundle.seeds ?? []).length} seed(s) (${alreadyHeld} already held` +
      (absorbed > 0
        ? `; endorsements verified: ${absorbed - endorsedByServer} from the tree, ${endorsedByServer} from the server's published keys`
        : '') +
      `) from ${frame.sender} in community ${frame.workspaceId.slice(0, 8)} - salon(s) ${[...repaired].map((id) => id.slice(0, 8)).join(', ') || 'none'}` +
      page
  );

  // A HISTORY ASK ANSWERED WITH A SEED THIS DEVICE DID NOT HOLD settles a widened ask
  // (`historyClosedSeen.ts`). Only a STORED one: a bundle of seeds already held, or of seeds all
  // refused here, is an answerer still giving the past it gave under the floor - and settling on it
  // would close the widening with nothing of the reopened past arrived.
  if (absorbed > 0) {
    noteHistoryAnswered(frame.workspaceId, String(bundle.requestId ?? ''));
  }

  if (bundle.truncated) {
    console.warn(
      `[GRAINE] ${frame.sender} sent a TRUNCATED bundle for community ${frame.workspaceId.slice(0, 8)} - some seeds are still missing`
    );
  }

  // "I HOLD NOTHING" ANSWERS A HISTORY ASK (section 24), and is believed only as the empty hand it
  // claims to be: a bundle that says it and carries seeds contradicts itself, so the flag is
  // dropped out loud and the seeds above were absorbed like any others.
  if (bundle.holdsNothing) {
    if ((bundle.seeds ?? []).length > 0) {
      console.warn(
        `[GRAINE] ${frame.sender} sent a bundle saying it holds nothing WITH ${(bundle.seeds ?? []).length} seed(s) in community ${frame.workspaceId.slice(0, 8)} - the claim is ignored`
      );
    } else {
      noteHistoryHeldNothing(
        frame.workspaceId,
        frame.sender,
        String(bundle.requestId ?? ''),
        frame.senderDeviceId ?? ''
      );
    }
  }

  // What the answerer turned out not to hold. Each one re-elects the next member of the roster, so
  // an unlucky election costs a round trip instead of costing the session for the whole app session.
  for (const sessionId of bundle.missingSessionIds ?? []) {
    if (sessionId)
      noteSeedUnavailable(
        String(sessionId),
        frame.sender,
        String(bundle.requestId ?? ''),
        frame.senderDeviceId ?? ''
      );
  }

  // The rows this repairs were rendered unreadable and dropped minutes ago; nothing else would go
  // back for them before the user next leaves and re-enters the salon.
  announceGraineRepair([...repaired]);
}
