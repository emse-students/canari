/**
 * The at-rest shape of a stored message's encrypted payload, shared by both storage backends.
 *
 * `SqliteStorage` and `IndexedDbStorage` encrypt the exact same object and decode it back the exact
 * same way; keeping that projection in one place is what stops a new field from being written by one
 * backend and silently dropped by the other - or, as happened with `editedAt`, added to the type and
 * to neither. Every optional field must survive the round trip below or it does not survive a reload.
 *
 * Compatibility: rows written before a field existed simply lack the key, and the decode treats a
 * missing or malformed value as `undefined`. That is the reader for the previous format - there is
 * no version tag and none is needed, because the payload only ever grows optional keys.
 */

import type { StoredMessage, StoredMessagePatch } from './types';

/** Identity fields stored in plaintext columns rather than inside the encrypted payload. */
export interface StoredMessageRowKeys {
  id: string;
  conversationId: string;
  /** Creation time as Unix ms, already normalised by the caller. */
  timestamp: number;
}

/**
 * Project a message to the object that gets encrypted.
 * Empty/falsy optionals are omitted so the ciphertext stays as small as it was before they existed.
 */
export function toMessagePayload(msg: StoredMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    senderId: msg.senderId.trim().toLowerCase(),
    content: msg.content,
  };
  if (msg.readBy && msg.readBy.length > 0) payload.readBy = msg.readBy;
  if (msg.reactions && msg.reactions.length > 0) payload.reactions = msg.reactions;
  if (msg.readAt) payload.readAt = msg.readAt;
  if (msg.serverTimestamp) payload.serverTimestamp = msg.serverTimestamp;
  if (msg.isDeleted) payload.isDeleted = true;
  if (msg.isEdited) payload.isEdited = true;
  if (msg.editedAt) payload.editedAt = msg.editedAt;
  return payload;
}

/**
 * Apply a patch to a stored message, returning a new message.
 *
 * A key the patch does not carry - absent, or present as `undefined` - leaves the stored value
 * alone. That is the whole point. Persisting a mutation used to mean rebuilding the WHOLE row out
 * of what the handler happened to know, and since `saveMessage` is a full-row replace, every field
 * the handler did not know about was erased: a reaction landing on a deleted message cleared the
 * tombstone, a read receipt on an edited one cleared `isEdited`. Each handler carried a different
 * subset, so the row's contents depended on which mutation touched it last.
 *
 * Clearing a field is still expressible, but only on purpose: pass `false`, `[]` or `0`.
 */
export function mergeStoredMessage(msg: StoredMessage, patch: StoredMessagePatch): StoredMessage {
  const defined = Object.entries(patch).filter(
    ([key, value]) => value !== undefined && key !== 'id' && key !== 'conversationId'
  );
  return Object.assign({ ...msg }, Object.fromEntries(defined));
}

/** Read a positive number out of an untrusted decrypted payload, or `undefined`. */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined;
}

/**
 * Rebuild a StoredMessage from its plaintext row keys and its decrypted payload.
 * The payload comes back from `decryptData` as `unknown` - every field is validated, never trusted.
 */
export function fromMessagePayload(
  keys: StoredMessageRowKeys,
  payload: Record<string, unknown>
): StoredMessage {
  return {
    id: keys.id,
    conversationId: keys.conversationId,
    timestamp: keys.timestamp,
    senderId: payload.senderId as string,
    content: payload.content as string,
    readBy: Array.isArray(payload.readBy) ? (payload.readBy as string[]) : undefined,
    reactions: Array.isArray(payload.reactions)
      ? (payload.reactions as StoredMessage['reactions'])
      : undefined,
    readAt: positiveNumber(payload.readAt),
    serverTimestamp: positiveNumber(payload.serverTimestamp),
    isDeleted: payload.isDeleted === true ? true : undefined,
    isEdited: payload.isEdited === true ? true : undefined,
    editedAt: positiveNumber(payload.editedAt),
  };
}
