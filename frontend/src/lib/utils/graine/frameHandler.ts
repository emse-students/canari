import type { DistributionFrame } from '$lib/mls-client/IMlsService';
import type { StoredGraineSession } from '$lib/db/types';
import type { canari } from '$lib/proto/canari';
import { canari as canariRuntime } from '$lib/proto/canari';
import { decodeAppMessage, encodeAppMessage, mkGraineBundle } from '$lib/proto/codec';
import { DELIVERY } from '$lib/mls-client/frameDelivery';
import { GRAINE_HISTORY_BUNDLE_MAX_SEEDS } from '$lib/crypto/graineConstants';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import { announceGraineRepair, cacheGraineSession, requireGraineRuntime } from './runtime';
import { mirrorGraineSeed } from './graineMirror';

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
    if (existing.sentCount !== undefined) return true;
    // A lower floor is strictly more history: same seed, more of it readable. Anything else is a
    // replay of what is already held.
    if (existing.firstIndex <= seed.firstIndex) return true;
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

  if (request.kind !== canariRuntime.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS) {
    // UNSPECIFIED is declined and logged, never guessed at: "repair these" and "send me
    // everything" would otherwise be one message with an empty field.
    console.warn(
      `[GRAINE] declining a request of kind ${request.kind} from ${frame.sender} - only SESSIONS is answered here`
    );
    return;
  }

  const wanted = (request.sessionIds ?? []).map(String).filter(Boolean);
  const seeds: canari.GraineMsg.$Properties[] = [];
  const missing: string[] = [];
  for (const sessionId of wanted.slice(0, GRAINE_HISTORY_BUNDLE_MAX_SEEDS)) {
    const held = await storage.getGraineSession(sessionId, deviceKeyB64);
    if (!held) {
      missing.push(sessionId);
      continue;
    }
    seeds.push({
      channelId: held.channelId,
      sessionId: held.sessionId,
      seed: fromBase64(held.seedB64),
      // The floor travels as ours: a member cannot hand over more than they were given
      // themselves, and raising it here is what stops a repair from widening access.
      firstIndex: held.firstIndex,
      createdAt: held.createdAt,
    });
  }

  if (missing.length > 0) {
    // Named rather than counted: this device was chosen as the holder and turned out not to be,
    // which is either a roster that moved under the requester or a seed lost on this side.
    console.warn(
      `[GRAINE] asked for ${wanted.length} seed(s) by ${frame.sender}, holding ${seeds.length} - missing ${missing.join(', ')}`
    );
  }
  if (seeds.length === 0) return;

  const bundle = encodeAppMessage(
    mkGraineBundle({
      workspaceId: frame.workspaceId,
      requestId: String(request.requestId ?? ''),
      seeds,
      // Stated rather than left to be inferred from a short list: "this is all there is" and "this
      // is all I could send" are different facts, and only one of them means ask again.
      truncated: wanted.length > GRAINE_HISTORY_BUNDLE_MAX_SEEDS,
    })
  );
  await mlsService.sendMessage(frame.groupId, bundle, undefined, DELIVERY.transport);
  console.info(`[GRAINE] answered ${frame.sender} with ${seeds.length} seed(s)`);
}

/** Stores the seeds of an answer and tells the UI which salons just became readable. */
async function absorbSeedBundle(
  frame: DistributionFrame,
  bundle: canari.GraineBundleMsg.$Properties
): Promise<void> {
  const repaired = new Set<string>();
  for (const seed of bundle.seeds ?? []) {
    const stored = await storeIncomingSeed(frame.workspaceId, frame.sender, {
      channelId: String(seed.channelId ?? ''),
      sessionId: String(seed.sessionId ?? ''),
      seed: seed.seed instanceof Uint8Array ? seed.seed : new Uint8Array(),
      firstIndex: Number(seed.firstIndex) || 0,
      createdAt: Number(seed.createdAt) || 0,
    });
    if (stored && seed.channelId) repaired.add(String(seed.channelId));
  }

  if (bundle.truncated) {
    console.warn(
      `[GRAINE] ${frame.sender} sent a TRUNCATED bundle for community ${frame.workspaceId.slice(0, 8)} - some seeds are still missing`
    );
  }
  // The rows this repairs were rendered unreadable and dropped minutes ago; nothing else would go
  // back for them before the user next leaves and re-enters the salon.
  announceGraineRepair([...repaired]);
}
