import { openWithGraine } from '$lib/crypto/graine';
import { GraineSignatureError, openWithGraineV2, sealWithGraineV2 } from '$lib/crypto/graineV2';
import type { StoredGraineSession, StoredGraineV2 } from '$lib/db/types';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import {
  cacheGraineSession,
  cachedGraineSession,
  claimOpenedKey,
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
import { endorseNewSession } from './endorseSession';
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
  /** The session key's signature over the header, nonce and ciphertext (Graine v2, section 21). */
  signature: string;
  /**
   * The frame that distributed this session's seed, and the key group it was sealed on - on EVERY
   * message, not the first: a push can be withheld (a salon set to mentions), so the first message a
   * phone RECEIVES under a session is not always the first one sent (channel-encryption section 19).
   */
  seedFrame: string;
  seedGroupId: string;
}

/** What opening a message needs, exactly as the server hands it back. */
export interface OpenableChannelMessage {
  /** The server row id - what a replay is told apart by. */
  id: string;
  /** The author the SERVER names. Under a v2 session it must be the session's minter. */
  senderId: string;
  ciphertext: string;
  nonce: string | null;
  senderSessionId: string | null;
  messageIndex: number | null;
  /** Graine v2's session signature; absent from a v1 row, and REQUIRED under a v2 session. */
  signature?: string | null;
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

/**
 * Thrown when a row under a v2 session names an author who is not the session's minter.
 *
 * The server relabelled it, or a member tried to post under a session that is not theirs. A FAULT,
 * never a missing seed: a repair would hand back the same seed, whose minter is still somebody else.
 */
export class GraineAuthorMismatchError extends Error {
  constructor(
    readonly sessionId: string,
    readonly claimed: string,
    readonly minter: string
  ) {
    super(
      `[GRAINE] AUTHOR MISMATCH session ${sessionId}: the row names ${claimed}, the session was minted by ${minter}`
    );
    this.name = 'GraineAuthorMismatchError';
  }
}

/** Thrown when a row under a v2 session is served in another salon than the session's. A FAULT. */
export class GraineChannelMismatchError extends Error {
  constructor(
    readonly sessionId: string,
    readonly servedIn: string,
    readonly sessionChannel: string
  ) {
    super(
      `[GRAINE] CHANNEL MISMATCH session ${sessionId}: served in ${servedIn.slice(0, 8)}, belongs to ${sessionChannel.slice(0, 8)}`
    );
    this.name = 'GraineChannelMismatchError';
  }
}

/**
 * Thrown for a second row naming a message key another row already opened - a replayed ciphertext.
 * Shown once: the first row stays, this one is not rendered.
 */
export class GraineReplayError extends Error {
  constructor(
    readonly sessionId: string,
    readonly index: number,
    readonly firstRowId: string
  ) {
    super(
      `[GRAINE] REPLAY of message ${index} of session ${sessionId}, first seen as ${firstRowId}`
    );
    this.name = 'GraineReplayError';
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
      endorse: (session) => endorseNewSession(mlsService, session),
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

  // GUARANTEED BY THE ROTATION, NOT HOPED FOR: `shouldRotateGraineSession` mints a new session for
  // any that lacks a frame, so reaching here without one is a broken invariant and says so.
  const frame = slot.session.distributionFrame;
  if (!frame) {
    throw new Error(
      `[GRAINE] session ${slot.session.sessionId} reached the seal with no distribution frame`
    );
  }

  // V2 BY THE SAME ROTATION: `shouldRotateGraineSession` mints anew any session this device cannot
  // sign under, so a missing secret here is a broken invariant too.
  const secret = slot.session.v2?.signingSecretKeyB64;
  if (!secret) {
    throw new Error(
      `[GRAINE] session ${slot.session.sessionId} reached the seal with no signing secret`
    );
  }
  const sealed = await sealWithGraineV2(
    fromBase64(slot.session.seedB64),
    {
      channelId: channel,
      sessionId: slot.session.sessionId,
      minterUserId: slot.session.senderId,
      index: slot.index,
    },
    payload,
    fromBase64(secret),
    mlsService.graineSignatureEngine()
  );
  return {
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    signature: sealed.signature,
    senderSessionId: slot.session.sessionId,
    messageIndex: slot.index,
    seedFrame: frame.protoB64,
    seedGroupId: frame.groupId,
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

  const { storage, deviceKeyB64, mlsService } = requireGraineRuntime(
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

  const bytes = session.v2
    ? await openV2Row(
        channel,
        {
          ...row,
          senderSessionId: row.senderSessionId,
          nonce: row.nonce,
          messageIndex: row.messageIndex,
        },
        session,
        session.v2,
        mlsService
      )
    : await openWithGraine(fromBase64(session.seedB64), row.senderSessionId, row.messageIndex, {
        ciphertext: row.ciphertext,
        nonce: row.nonce,
      });

  // AFTER the row authenticated, never before: a forged row claiming the key first would otherwise
  // be the one shown and the real one refused as its replay.
  const first = claimOpenedKey(row.senderSessionId, row.messageIndex, row.id);
  if (first !== null) {
    throw new GraineReplayError(row.senderSessionId, row.messageIndex, first);
  }
  return bytes;
}

/**
 * Opens a row under a v2 session: the author and the salon the server names are checked against
 * what the session was ENDORSED with, then the signature and the additional data bind the rest.
 *
 * The version belongs to the session, which came over MLS, so a server cannot downgrade the row by
 * dropping its signature: a v2 session's row with none is refused like a bad one.
 *
 * Nothing here logs: every refusal is a typed FAULT the caller reports once per page, at ERROR
 * (`reportUnreadableChannelMessage`), so a relabelled page is one line and not two hundred.
 */
async function openV2Row(
  channel: string,
  row: OpenableChannelMessage & { senderSessionId: string; nonce: string; messageIndex: number },
  session: StoredGraineSession,
  v2: StoredGraineV2,
  mlsService: IMlsService
): Promise<Uint8Array> {
  const sessionChannel = rawChannelId(session.channelId);
  if (sessionChannel !== channel) {
    throw new GraineChannelMismatchError(row.senderSessionId, channel, sessionChannel);
  }
  // Ids are compared as the rest of the client reads them, lowercased. The SIGNED header uses the
  // minter exactly as endorsed, so the case of the served id changes nothing it proves.
  if (row.senderId.toLowerCase() !== session.senderId.toLowerCase()) {
    throw new GraineAuthorMismatchError(row.senderSessionId, row.senderId, session.senderId);
  }
  if (!row.signature) {
    throw new GraineSignatureError('malformed-signature', 'message');
  }
  return openWithGraineV2(
    fromBase64(session.seedB64),
    {
      channelId: session.channelId,
      sessionId: row.senderSessionId,
      minterUserId: session.senderId,
      index: row.messageIndex,
    },
    { ciphertext: row.ciphertext, nonce: row.nonce, signature: row.signature },
    fromBase64(v2.signingPublicKeyB64),
    mlsService.graineSignatureEngine()
  );
}
