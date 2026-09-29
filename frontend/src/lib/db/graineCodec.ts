/**
 * Shared (de)serialisation for persisted Graine session rows, so IndexedDB and SQLite cannot
 * disagree about what a row is - the same split the outbox already uses.
 *
 * A row is:
 *  - clear columns (`sessionId`, `workspaceId`, `channelId`, `senderId`, `firstIndex`,
 *    `createdAt`, `sentCount`): everything needed to LIST, order, count and purge sessions without
 *    the device key, which is what makes a purge on leaving a community possible at all;
 *  - an encrypted blob holding the seed - the only secret in the row, so encrypting it with the
 *    device key puts it in exactly the same posture as a stored message - and, on a session this
 *    device minted, the frame that distributed it. The frame is not secret (an MLS ciphertext), it
 *    rides in the blob because that needs no column in either store and a backup carries it as is.
 *    A v2 session's endorsement and keys ride there too, for the same reason - and the session
 *    SECRET, on a session this device minted, is the one v2 field that has to be encrypted.
 */

import type {
  EncryptedGraineRow,
  GraineDistributionFrame,
  StoredGraineSession,
  StoredGraineV2,
} from './types';

/** Non-encrypted columns of a persisted Graine row. */
export interface GraineClearColumns {
  sessionId: string;
  workspaceId: string;
  channelId: string;
  senderId: string;
  firstIndex: number;
  createdAt: number;
  sentCount?: number;
  distributionEpoch?: number;
}

/** The clear columns of a session, ready to be written beside its encrypted seed. */
export function graineClearColumns(session: StoredGraineSession): GraineClearColumns {
  return {
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    channelId: session.channelId,
    senderId: session.senderId,
    firstIndex: session.firstIndex,
    createdAt: session.createdAt,
    sentCount: session.sentCount,
    distributionEpoch: session.distributionEpoch,
  };
}

/** The payload that gets encrypted: the seed, the distribution frame when this device minted it, and v2's half. */
export function encodeGraineSensitive(session: StoredGraineSession): Record<string, unknown> {
  return {
    seedB64: session.seedB64,
    ...(session.distributionFrame ? { distributionFrame: session.distributionFrame } : {}),
    ...(session.v2 ? { v2: session.v2 } : {}),
  };
}

/** The frame out of a decrypted payload, or undefined for anything that is not one - an older row. */
function frameOf(payload: unknown): GraineDistributionFrame | undefined {
  const f = (payload as { distributionFrame?: { groupId?: unknown; protoB64?: unknown } } | null)
    ?.distributionFrame;
  return f && typeof f.groupId === 'string' && typeof f.protoB64 === 'string'
    ? { groupId: f.groupId, protoB64: f.protoB64 }
    : undefined;
}

/**
 * The v2 half out of a decrypted payload, or undefined for a v1 row. All three public fields or none:
 * a half-read v2 block would be a session the reader treats as v2 with nothing to verify against.
 */
function v2Of(payload: unknown): StoredGraineV2 | undefined {
  const v = (payload as { v2?: Partial<Record<keyof StoredGraineV2, unknown>> } | null)?.v2;
  if (
    !v ||
    typeof v.minterDeviceId !== 'string' ||
    typeof v.signingPublicKeyB64 !== 'string' ||
    typeof v.endorsementB64 !== 'string'
  ) {
    return undefined;
  }
  return {
    minterDeviceId: v.minterDeviceId,
    signingPublicKeyB64: v.signingPublicKeyB64,
    endorsementB64: v.endorsementB64,
    ...(typeof v.signingSecretKeyB64 === 'string'
      ? { signingSecretKeyB64: v.signingSecretKeyB64 }
      : {}),
  };
}

/**
 * Rebuilds a session from its clear columns and its decrypted payload.
 *
 * Every numeric field is coerced, because SQLite hands back whatever the driver decided and a
 * `firstIndex` arriving as the string "0" would be truthy in one comparison and zero in the next.
 */
export function decodeGraineSession(
  row: GraineClearColumns,
  payload: unknown
): StoredGraineSession {
  const seed = (payload as { seedB64?: unknown } | null)?.seedB64;
  const sentCount = Number(row.sentCount);
  // A row written before the column existed has no epoch, and `Number(null)` is 0 - an epoch a
  // real group genuinely has. Absent has to stay absent, because "minted before we recorded the
  // roster" and "minted at epoch 0" are the same row only if this coercion says so.
  const distributionEpoch = row.distributionEpoch == null ? NaN : Number(row.distributionEpoch);
  return {
    sessionId: String(row.sessionId),
    workspaceId: String(row.workspaceId),
    channelId: String(row.channelId),
    senderId: String(row.senderId),
    firstIndex: Number(row.firstIndex) || 0,
    createdAt: Number(row.createdAt) || 0,
    sentCount: Number.isFinite(sentCount) ? sentCount : undefined,
    distributionEpoch: Number.isFinite(distributionEpoch) ? distributionEpoch : undefined,
    seedB64: typeof seed === 'string' ? seed : '',
    distributionFrame: frameOf(payload),
    v2: v2Of(payload),
  };
}

/**
 * Newest session first, ties broken by id.
 *
 * Deterministic on purpose: two devices reading the same set must agree on which sessions the
 * bounded native mirror keeps, or the same push would decrypt on one phone and not on another.
 */
export function byNewestSession(a: StoredGraineSession, b: StoredGraineSession): number {
  return b.createdAt - a.createdAt || a.sessionId.localeCompare(b.sessionId);
}

/**
 * The backup row for a session whose seed is already encrypted.
 *
 * `iv` and `cipherText` stay binary here, exactly as a message row's do: the backup file is the
 * only place that serialises them, and it does it in ONE way for every kind of row.
 */
export function toEncryptedGraineRow(
  clear: GraineClearColumns,
  encrypted: { iv: Uint8Array; cipherText: Uint8Array }
): EncryptedGraineRow {
  return { ...clear, iv: encrypted.iv, cipherText: encrypted.cipherText };
}
