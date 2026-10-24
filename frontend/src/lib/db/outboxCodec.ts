import { fromBase64, toBase64 } from '$lib/utils/hex';
import type { OutboxBlobRef, OutboxEntry } from './types';

// ---------------------------------------------------------------------------
// Shared (de)serialization for persisted outbox rows.
//
// An outbox row splits into:
//  - clear columns (id, conversationId, sentAt, kind, status, attempts, lastAttemptAt,
//    nextAttemptAt, serverErrors, createdAt): authoritative for querying/sorting/re-keying without the PIN,
//    mirroring the StoredMessage convention (timestamp/conversationId stored in the clear).
//  - an encrypted blob: the sensitive payload { text, replyTo, media }. Binary media bytes are
//    base64-encoded so they survive JSON serialization inside encryptData/decryptData.
// ---------------------------------------------------------------------------

/** Non-encrypted columns of a persisted outbox row. */
export interface OutboxClearColumns {
  id: string;
  conversationId: string;
  sentAt: number;
  kind: OutboxEntry['kind'];
  status: OutboxEntry['status'];
  attempts: number;
  lastAttemptAt?: number;
  nextAttemptAt?: number;
  serverErrors?: number;
  createdAt: number;
}

/**
 * The payload of a queued row could not be decrypted or parsed. Typed so the outbox can tell a row
 * this device will NEVER read (a key that no longer matches, a damaged blob) from an absent one,
 * without matching a message.
 */
export class OutboxPayloadUnreadableError extends Error {
  readonly entryId: string;
  constructor(entryId: string, cause: unknown) {
    super(`outbox payload of ${entryId} is unreadable`, { cause });
    this.name = 'OutboxPayloadUnreadableError';
    this.entryId = entryId;
  }
}

/** Decode a base64 string back to a Uint8Array; returns an empty array on failure. */
function base64ToUint8(val: unknown): Uint8Array {
  if (typeof val !== 'string') return new Uint8Array(0);
  try {
    return fromBase64(val);
  } catch {
    return new Uint8Array(0);
  }
}

/** Extract the clear (non-encrypted) columns from an entry. */
export function outboxClearColumns(entry: OutboxEntry): OutboxClearColumns {
  return {
    id: entry.id,
    conversationId: entry.conversationId,
    sentAt: entry.sentAt,
    kind: entry.kind,
    status: entry.status,
    attempts: entry.attempts,
    lastAttemptAt: entry.lastAttemptAt,
    nextAttemptAt: entry.nextAttemptAt,
    serverErrors: entry.serverErrors,
    createdAt: entry.createdAt,
  };
}

/**
 * Build the sensitive payload object to encrypt. THE FILE BYTES ARE NEVER IN IT: a queued attachment
 * lives in the blob store ({@link ./outboxBlob}), and the payload keeps only `media.blob.keyB64`, so
 * a row stays under ~1 KB however large the file is.
 *
 * `written` names the blob (key and slot) the storage layer has JUST committed for this entry. Without
 * one, an existing `media.blob` reference is carried over unless the file has been uploaded
 * (`uploadedRef`): from then on nothing reads the bytes, and the reference is dropped so the
 * caller can delete the blob. Rows written before this format held the bytes inline as
 * `fileBytesB64`; they are still READ ({@link decodeOutboxEntry}) and never written again.
 */
export function encodeOutboxSensitive(
  entry: OutboxEntry,
  written?: OutboxBlobRef
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (entry.text !== undefined) payload.text = entry.text;
  if (entry.replyTo) payload.replyTo = entry.replyTo;
  if (entry.media) {
    const { fileBytes: _bytes, blob, ...rest } = entry.media;
    const keep = written ? { blob: written } : blob && !rest.uploadedRef ? { blob } : {};
    payload.media = { ...rest, ...keep };
  }
  if (entry.controlProto && entry.controlProto.length > 0) {
    payload.controlProtoB64 = toBase64(entry.controlProto);
  }
  return payload;
}

/**
 * Reconstruct an {@link OutboxEntry} from its clear columns and decrypted payload. With no payload
 * (`undefined`) the entry carries its scheduling columns only: that is what a queue READ returns for
 * a media row, whose payload is the whole file.
 */
export function decodeOutboxEntry(clear: OutboxClearColumns, payload?: any): OutboxEntry {
  let media: OutboxEntry['media'];
  if (payload?.media) {
    // `fileBytesB64` is the pre-blob inline format, read lazily here so a row queued by an older
    // build is still sent; a `blob` reference is left for the storage layer to resolve.
    const { fileBytesB64, ...rest } = payload.media;
    media = {
      ...rest,
      ...(typeof fileBytesB64 === 'string' ? { fileBytes: base64ToUint8(fileBytesB64) } : {}),
    };
  }
  return {
    id: clear.id,
    conversationId: clear.conversationId,
    sentAt: clear.sentAt,
    kind: clear.kind,
    status: clear.status,
    attempts: clear.attempts,
    lastAttemptAt: clear.lastAttemptAt,
    nextAttemptAt: clear.nextAttemptAt,
    serverErrors: clear.serverErrors,
    createdAt: clear.createdAt,
    text: typeof payload?.text === 'string' ? payload.text : undefined,
    replyTo: payload?.replyTo,
    media,
    controlProto:
      typeof payload?.controlProtoB64 === 'string'
        ? base64ToUint8(payload.controlProtoB64)
        : undefined,
  };
}

/**
 * The clear scheduling columns a store may update in place. ONE list, read by both stores, so a
 * column added here cannot be written by one and silently dropped by the other.
 */
export const OUTBOX_CLEAR_PATCH_KEYS = [
  'status',
  'attempts',
  'lastAttemptAt',
  'nextAttemptAt',
  'serverErrors',
] as const;

/**
 * True when a patch touches ONLY the clear scheduling columns ({@link OUTBOX_CLEAR_PATCH_KEYS}), so a
 * store can update them in place without decoding or re-encrypting the payload - which for a media
 * entry holds the whole file.
 */
export function isOutboxClearPatch(patch: Partial<OutboxEntry>): boolean {
  const keys = Object.keys(patch).filter(
    (k) => (patch as Record<string, unknown>)[k] !== undefined
  );
  return (
    keys.length > 0 && keys.every((k) => (OUTBOX_CLEAR_PATCH_KEYS as readonly string[]).includes(k))
  );
}

/** Apply a partial patch to an entry, returning a new merged entry. */
export function mergeOutboxEntry(entry: OutboxEntry, patch: Partial<OutboxEntry>): OutboxEntry {
  const merged = { ...entry, ...patch };
  if (patch.media) merged.media = { ...entry.media, ...patch.media } as OutboxEntry['media'];
  return merged;
}
