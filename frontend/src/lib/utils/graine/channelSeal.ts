import { GraineSealUnavailableError } from './sealUnavailable';
import { openWithGraine } from '$lib/crypto/graine';
import {
  finishGraineV2Open,
  GraineSignatureError,
  prepareGraineV2Open,
  requireGraineVerdicts,
  sealWithGraineV2,
  type GraineSignatureCheck,
  type GraineSignatureEngine,
  type GraineSignatureVerdict,
  type PreparedGraineV2Open,
} from '$lib/crypto/graineV2';
import type { StoredGraineSession, StoredGraineV2 } from '$lib/db/types';
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
  GraineDistributionUnavailableError,
  readDistributionEpoch,
  readKeyGroupRun,
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
 * Thrown when a v2 row reaches its final step with no signature verdict: the engine answered fewer
 * verdicts than it was asked, a defect upstream and never a row to skip.
 */
export class GraineVerdictMissingError extends Error {
  constructor(readonly sessionId: string) {
    super(`[GRAINE] v2 row of session ${sessionId} finished without a signature verdict`);
    this.name = 'GraineVerdictMissingError';
  }
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
 * Thrown when an UNSIGNED row names a session this device does not hold.
 *
 * An unsigned row can only open under a v1 seed (a v2 session refuses a row with no signature), and
 * a v1 seed that ARRIVES is refused since `minClientVersion` reached the v2 writer (channel-encryption
 * section 21.7). So no peer can make this row readable here, and asking one would be learning by
 * failing what the missing signature already says. Deliberately NOT a
 * {@link GraineSessionUnavailableError}: that class is the one that asks.
 *
 * A server that strips the signature of a v2 row this device lacks the seed for lands here too. It
 * can only make that row unreadable, which withholding the row would do as well.
 */
export class GraineV1SessionNotHeldError extends Error {
  constructor(
    readonly sessionId: string,
    readonly channelId: string
  ) {
    super(
      `[GRAINE] unsigned row under session ${sessionId} in channel ${channelId.slice(0, 8)}: a v1 session this device does not hold, and a v1 seed is no longer accepted`
    );
    this.name = 'GraineV1SessionNotHeldError';
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
export class GraineUnknownChannelError extends GraineSealUnavailableError {
  constructor(readonly channelId: string) {
    super(
      `[GRAINE] channel ${channelId.slice(0, 8)} belongs to no community this session has loaded`,
      'unknown-channel'
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
  const { storage, deviceKey, userId, mlsService } = requireGraineRuntime(
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
  const reading = readDistributionEpoch(mlsService, scope);
  if ('unavailable' in reading) {
    const refusal = new GraineDistributionUnavailableError(scope, reading.unavailable);
    // AT A LEVEL THAT ACCUSES: nothing left the device, and the member sees a refusal. Which of the
    // four facts was missing is what tells a join not landed from a catch-up that never closed.
    console.error(`[SEND] seal refused for channel ${channel.slice(0, 8)}: ${refusal.message}`);
    throw refusal;
  }
  const distributionEpoch = reading.epoch;

  const slot = await reserveOutboundSlot(
    {
      storage,
      deviceKeyB64: deviceKey(),
      distributionEpoch,
      readRun: () => readKeyGroupRun(mlsService, scope),
      distribute: (session) => distributeGraineSeed(mlsService, scope, session),
      endorse: (session) => endorseNewSession(mlsService, session),
    },
    { workspaceId, channelId: channel, senderId: userId }
  );
  // A re-distributed session carries a new frame; the cache must not hand the old one back.
  if (slot.redistributed) cacheGraineSession(slot.session);
  if (slot.minted) {
    cacheGraineSession(slot.session);
    // This device's own sessions are mirrored too: a push echoing our own salon message to our
    // OTHER devices carries the same session, and those devices mirror it on receipt - but the
    // sending device is also a receiving one for everything that follows in the salon.
    await mirrorGraineSeed(slot.session);
  }

  // GUARANTEED BY THE ROTATION, NOT HOPED FOR: `graineOutboundVerdict` mints a new session for
  // any that lacks a frame, so reaching here without one is a broken invariant and says so.
  const frame = slot.session.distributionFrame;
  if (!frame) {
    throw new Error(
      `[GRAINE] session ${slot.session.sessionId} reached the seal with no distribution frame`
    );
  }

  // V2 BY THE SAME ROTATION: `graineOutboundVerdict` mints anew any session this device cannot
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
  return (await openChannelMessageProving(channelId, row)).bytes;
}

/** A live row's plaintext, and whether the open PROVED who wrote it. */
export interface ProvenChannelOpening {
  bytes: Uint8Array;
  /**
   * True only under a Graine v2 session, whose open checked the minter the server named and the
   * session's signature (channel-encryption section 21). A v1 row opens for whoever the server
   * names, so its `senderId` is only the server's word. The SAME fact the native push reader hands
   * its banner as `authorProven` (`background.rs` `open_graine_push`): the WebSocket trigger of a
   * salon banner carries it to the native builder, so both triggers name one speaker.
   */
  authorProven: boolean;
}

/**
 * {@link openChannelMessage}, keeping the one fact the open learns about the AUTHOR: whether it was
 * proven. Same checks, same typed throws.
 */
export async function openChannelMessageProving(
  channelId: string,
  row: OpenableChannelMessage
): Promise<ProvenChannelOpening> {
  const prepared = await prepareChannelMessage(channelId, row);
  const verdict =
    prepared.kind === 'v2'
      ? await prepared.engine.verifySignature(
          prepared.open.check.publicKey,
          prepared.open.check.message,
          prepared.open.check.signature
        )
      : undefined;
  return {
    bytes: await finishChannelMessage(prepared, verdict),
    authorProven: prepared.kind === 'v2',
  };
}

/** What one row of a page came to: its plaintext, or the typed reason it cannot be shown. */
export type ChannelPageOpening = { ok: true; bytes: Uint8Array } | { ok: false; error: unknown };

/**
 * The most checks one engine call carries. A salon page is 200 rows; a whole-history search pages
 * up to 2000, and splitting it keeps each crossing of the bridge, and each blocking task in the
 * engine, the size of one page.
 */
export const GRAINE_SIGNATURE_BATCH_MAX = 256;

/**
 * Opens a PAGE of rows with ONE engine call for its signatures (F7, `community-open-budget.md`),
 * where {@link openChannelMessage} row by row made one per row.
 *
 * **Every row gets exactly what {@link openChannelMessage} would have given it**, the same value or
 * the same typed throw, because both run the same three steps:
 * 1. {@link prepareChannelMessage} for every row, in order: the session, the floor, the salon, the
 *    author, the signature's presence and length - each failure kept as that row's outcome;
 * 2. ONE `verifySignatures` for every row that reached the check, each verdict handed back to its
 *    own row by position - one forged row refuses itself and nobody else;
 * 3. {@link finishChannelMessage} for every row, IN PAGE ORDER: the decrypt, then the replay claim -
 *    so the first row naming a key is still the one that keeps it.
 *
 * An engine call that FAILS (a broken bridge, never a signature that does not verify) is the outcome
 * of every row it carried and of no other, as it was each row's when each made its own call.
 */
export async function openChannelMessagePage(
  channelId: string,
  rows: readonly OpenableChannelMessage[]
): Promise<ChannelPageOpening[]> {
  const prepared: ({ ok: true; row: PreparedChannelMessage } | { ok: false; error: unknown })[] =
    [];
  for (const row of rows) {
    try {
      prepared.push({ ok: true, row: await prepareChannelMessage(channelId, row) });
    } catch (error) {
      prepared.push({ ok: false, error });
    }
  }

  // The rows that reached the signature check, by their position in the page.
  const waiting: { at: number; check: GraineSignatureCheck; engine: GraineSignatureEngine }[] = [];
  for (const [at, p] of prepared.entries()) {
    if (p.ok && p.row.kind === 'v2') {
      waiting.push({ at, check: p.row.open.check, engine: p.row.engine });
    }
  }
  const verdicts = new Map<number, GraineSignatureVerdict>();
  // A failed call is the outcome of ITS rows only: each batch stands alone, as each row's own call did.
  const engineFailures = new Map<number, unknown>();
  for (let from = 0; from < waiting.length; from += GRAINE_SIGNATURE_BATCH_MAX) {
    const slice = waiting.slice(from, from + GRAINE_SIGNATURE_BATCH_MAX);
    try {
      // One runtime, one engine: every row of the page was prepared against the same MLS service.
      // A broken engine contract is refused whole: a verdict handed to the wrong row is a forged
      // row shown, so nothing is believed from an answer of the wrong shape.
      const answer = requireGraineVerdicts(
        await slice[0].engine.verifySignatures(slice.map((w) => w.check)),
        slice.length
      );
      slice.forEach((w, k) => verdicts.set(w.at, answer[k]));
    } catch (error) {
      console.error(
        `[GRAINE] signature batch of ${rawChannelId(channelId).slice(0, 8)} failed, ${slice.length} row(s) left unread: ${String(error)}`
      );
      for (const w of slice) engineFailures.set(w.at, error);
    }
  }

  const out: ChannelPageOpening[] = [];
  for (const [i, p] of prepared.entries()) {
    if (!p.ok) {
      out.push(p);
      continue;
    }
    try {
      if (engineFailures.has(i)) throw engineFailures.get(i);
      out.push({ ok: true, bytes: await finishChannelMessage(p.row, verdicts.get(i)) });
    } catch (error) {
      out.push({ ok: false, error });
    }
  }
  return out;
}

/** A row ready for its signature check (v2), or one that opens without one (v1). */
type PreparedChannelMessage =
  | {
      kind: 'v2';
      row: OpenableChannelMessage & { senderSessionId: string; messageIndex: number };
      seed: Uint8Array;
      open: PreparedGraineV2Open;
      engine: GraineSignatureEngine;
    }
  | {
      kind: 'v1';
      row: OpenableChannelMessage & {
        senderSessionId: string;
        nonce: string;
        messageIndex: number;
      };
      seed: Uint8Array;
    };

/**
 * Everything {@link openChannelMessage} does before the signature check, with the same throws in
 * the same order: the row's fields, its session, the handover floor, then under a v2 session the
 * salon and the author against what the session was ENDORSED with, the signature's presence and
 * its length.
 *
 * The version belongs to the session, which came over MLS, so a server cannot downgrade the row by
 * dropping its signature: a v2 session's row with none is refused like a bad one.
 *
 * Nothing here logs: every refusal is a typed FAULT the caller reports once per page, at ERROR
 * (`reportUnreadableChannelMessage`), so a relabelled page is one line and not two hundred.
 */
async function prepareChannelMessage(
  channelId: string,
  row: OpenableChannelMessage
): Promise<PreparedChannelMessage> {
  const channel = rawChannelId(channelId);
  if (!row.senderSessionId || row.nonce === null || row.messageIndex === null) {
    throw new GraineSessionUnavailableError(row.senderSessionId ?? '(none)', channel);
  }

  const { storage, deviceKey, mlsService } = requireGraineRuntime(
    `cannot open a message of channel ${channel.slice(0, 8)}`
  );
  let session = cachedGraineSession(row.senderSessionId);
  if (!session) {
    session = await storage.getGraineSession(row.senderSessionId, deviceKey());
    if (session) cacheGraineSession(session);
  }
  if (!session) {
    // No signature means v1, and a v1 seed is refused on arrival (section 21.7): asking a peer for
    // it would fetch a seed this device then refuses, for every such row, for ever.
    if (!row.signature) throw new GraineV1SessionNotHeldError(row.senderSessionId, channel);
    throw new GraineSessionUnavailableError(row.senderSessionId, channel);
  }
  if (row.messageIndex < session.firstIndex) {
    throw new GraineBelowFirstIndexError(row.senderSessionId, row.messageIndex, session.firstIndex);
  }
  const typed = {
    ...row,
    senderSessionId: row.senderSessionId,
    nonce: row.nonce,
    messageIndex: row.messageIndex,
  };
  if (!session.v2) {
    return { kind: 'v1', row: typed, seed: fromBase64(session.seedB64) };
  }
  // The row's checks first, then the seed: the order the single open always took.
  const open = prepareV2Row(channel, typed, session, session.v2);
  return {
    kind: 'v2',
    row: typed,
    seed: fromBase64(session.seedB64),
    open,
    engine: mlsService.graineSignatureEngine(),
  };
}

/**
 * The checks a v2 row owes before its signature: the author and the salon the server names
 * against the session's endorsement, then the signature's presence and shape.
 */
function prepareV2Row(
  channel: string,
  row: OpenableChannelMessage & { senderSessionId: string; nonce: string; messageIndex: number },
  session: StoredGraineSession,
  v2: StoredGraineV2
): PreparedGraineV2Open {
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
  return prepareGraineV2Open(
    {
      channelId: session.channelId,
      sessionId: row.senderSessionId,
      minterUserId: session.senderId,
      index: row.messageIndex,
    },
    { ciphertext: row.ciphertext, nonce: row.nonce, signature: row.signature },
    fromBase64(v2.signingPublicKeyB64)
  );
}

/**
 * Everything {@link openChannelMessage} does after the signature check: a v2 row refused unless its
 * own verdict is `valid`, the decrypt, then the replay claim.
 */
async function finishChannelMessage(
  prepared: PreparedChannelMessage,
  verdict: GraineSignatureVerdict | undefined
): Promise<Uint8Array> {
  const { row } = prepared;
  let bytes: Uint8Array;
  if (prepared.kind === 'v2') {
    if (verdict === undefined) throw new GraineVerdictMissingError(row.senderSessionId);
    bytes = await finishGraineV2Open(prepared.seed, prepared.open, verdict);
  } else {
    bytes = await openWithGraine(prepared.seed, row.senderSessionId, row.messageIndex, {
      ciphertext: row.ciphertext,
      nonce: prepared.row.nonce,
    });
  }

  // AFTER the row authenticated, never before: a forged row claiming the key first would otherwise
  // be the one shown and the real one refused as its replay.
  const first = claimOpenedKey(row.senderSessionId, row.messageIndex, row.id);
  if (first !== null) {
    throw new GraineReplayError(row.senderSessionId, row.messageIndex, first);
  }
  return bytes;
}
