import { openWithGraine, sealWithGraine } from '$lib/crypto/graine';
import {
  cacheGraineSession,
  cachedGraineSession,
  rawChannelId,
  requireGraineRuntime,
  scopeForChannel,
} from './runtime';
import {
  distributeGraineSeed,
  distributionEpochFor,
  GraineDistributionUnavailableError,
} from './seedDistribution';
import { reserveOutboundSlot } from './sessionManager';
import { mirrorGraineSeed } from './graineMirror';
import { fromBase64 } from '$lib/utils/hex';

/**
 * Sealing and opening ONE channel message under a Graine session.
 *
 * The seam that replaces the server-derived epoch key. Everything above it (`channelCrypto`) still
 * deals in a ciphertext, a nonce and a row; what changed underneath is that the server holds no key
 * to any of it.
 *
 * Protocol: `docs/wiki/protocols/channel-encryption.md`.
 */

/** What a sealed channel message puts on the wire. */
export interface SealedChannelMessage {
  ciphertext: string;
  nonce: string;
  senderSessionId: string;
  messageIndex: number;
}

/** The three fields opening a message needs, exactly as the server hands them back. */
export interface OpenableChannelMessage {
  ciphertext: string;
  nonce: string | null;
  senderSessionId: string | null;
  messageIndex: number | null;
}

/**
 * Thrown when this device does not hold the seed a message names.
 *
 * A TYPE, because it is the one unreadability a repair can fix (WP-33), and the caller decides
 * that from the class - never from the sentence. It carries the session id so the request can be
 * addressed without re-parsing anything.
 */
export class GraineSessionUnavailableError extends Error {
  constructor(
    readonly sessionId: string,
    readonly channelId: string
  ) {
    super(`[GRAINE] no seed for session ${sessionId} in channel ${channelId.slice(0, 8)}`);
    this.name = 'GraineSessionUnavailableError';
  }
}

/**
 * Thrown when a message sits below the first index this device may derive.
 *
 * Deliberately NOT the same failure as a missing seed, though both render the same way. This one
 * is the protocol working: the seed was handed over mid-session, and the messages before it are
 * ones this member was not yet entitled to. A repair would return the identical seed, so asking
 * for one would loop for ever.
 */
export class GraineBelowFirstIndexError extends Error {
  constructor(
    readonly sessionId: string,
    readonly index: number,
    readonly firstIndex: number
  ) {
    super(
      `[GRAINE] message ${index} of session ${sessionId} is below the handover floor ${firstIndex}`
    );
    this.name = 'GraineBelowFirstIndexError';
  }
}

/** Thrown when a channel's community is unknown to this session, so nothing can be sealed for it. */
export class GraineUnknownChannelError extends Error {
  constructor(readonly channelId: string) {
    super(
      `[GRAINE] channel ${channelId.slice(0, 8)} belongs to no community this session has loaded`
    );
    this.name = 'GraineUnknownChannelError';
  }
}

/**
 * Seals `payload` for `channelId` under this device's current outbound session.
 *
 * Everything hard is one layer down: {@link reserveOutboundSlot} decides whether the session in
 * hand may still be used, mints and distributes one when it may not, and hands back an index that
 * is reserved exactly once.
 */
export async function sealChannelMessage(
  channelId: string,
  payload: Uint8Array
): Promise<SealedChannelMessage> {
  const channel = rawChannelId(channelId);
  const { storage, deviceKeyB64, userId, mlsService } = requireGraineRuntime(
    `cannot seal a message for channel ${channel.slice(0, 8)}`
  );

  // THE SCOPE, not the community: a private salon's seed travels on the salon's own group, whose
  // roster is the people who may open it. Reading the community here is what used to seal every
  // private salon's seed to every member of the community.
  const scope = scopeForChannel(channel);
  if (!scope) throw new GraineUnknownChannelError(channel);
  const workspaceId = scope.workspaceId;

  // Null, not zero: a scope whose distribution group is not in hand cannot receive a seed, so
  // sealing under a session nobody will ever be able to read is refused here rather than
  // discovered by every reader separately.
  const distributionEpoch = distributionEpochFor(mlsService, scope);
  if (distributionEpoch === null) throw new GraineDistributionUnavailableError(scope);

  const slot = await reserveOutboundSlot(
    {
      storage,
      deviceKeyB64,
      distributionEpoch,
      distribute: (session) => distributeGraineSeed(mlsService, scope, session),
    },
    { workspaceId, channelId: channel, senderId: userId }
  );
  if (slot.minted) {
    cacheGraineSession(slot.session);
    // This device's own sessions are mirrored too: a push echoing our own salon message to our
    // OTHER devices carries the same session, and those devices mirror it on receipt - but the
    // sending device is also a receiving one for everything that follows in the salon.
    await mirrorGraineSeed(slot.session);
  }

  const sealed = await sealWithGraine(
    fromBase64(slot.session.seedB64),
    slot.session.sessionId,
    slot.index,
    payload
  );
  return {
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    senderSessionId: slot.session.sessionId,
    messageIndex: slot.index,
  };
}

/**
 * Opens a channel message row, or throws the reason it cannot be opened.
 *
 * **Every failure is a throw with a type, never a null.** An unreadable message and an empty one
 * are different facts, and the whole point of this rework is that the second one stops being how
 * the first one looks.
 */
export async function openChannelMessage(
  channelId: string,
  row: OpenableChannelMessage
): Promise<Uint8Array> {
  const channel = rawChannelId(channelId);
  if (!row.senderSessionId || row.nonce === null || row.messageIndex === null) {
    throw new GraineSessionUnavailableError(row.senderSessionId ?? '(none)', channel);
  }

  const { storage, deviceKeyB64 } = requireGraineRuntime(
    `cannot open a message of channel ${channel.slice(0, 8)}`
  );
  let session = cachedGraineSession(row.senderSessionId);
  if (!session) {
    session = await storage.getGraineSession(row.senderSessionId, deviceKeyB64);
    if (session) cacheGraineSession(session);
  }
  if (!session) throw new GraineSessionUnavailableError(row.senderSessionId, channel);
  if (row.messageIndex < session.firstIndex) {
    throw new GraineBelowFirstIndexError(row.senderSessionId, row.messageIndex, session.firstIndex);
  }

  return openWithGraine(fromBase64(session.seedB64), row.senderSessionId, row.messageIndex, {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
  });
}
