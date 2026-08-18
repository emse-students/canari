import type { DistributionFrame } from '$lib/mls-client/IMlsService';
import type { StoredGraineSession } from '$lib/db/types';
import { decodeAppMessage } from '$lib/proto/codec';
import { toBase64 } from '$lib/utils/hex';
import { cacheGraineSession, requireGraineRuntime } from './runtime';
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

  // A request and a bundle are WP-33. Reaching here with one means a peer is already speaking a
  // protocol this bundle does not answer, which is a version skew worth naming rather than a
  // silence that reads as "nothing arrived".
  console.warn(
    `[GRAINE] distribution frame of kind '${msg.kind ?? 'unknown'}' from ${frame.sender} is not handled by this client`
  );
}
