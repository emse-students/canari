import type { OutboxEntry } from './types';

// ---------------------------------------------------------------------------
// Shared (de)serialization for persisted outbox rows.
//
// An outbox row splits into:
//  - clear columns (id, conversationId, sentAt, kind, status, attempts, lastAttemptAt,
//    nextAttemptAt, createdAt): authoritative for querying/sorting/re-keying without the PIN,
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
  createdAt: number;
}

/** Encode a binary buffer as a base64 string for JSON-safe storage in the encrypted payload. */
function uint8ToBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary);
}

/** Decode a base64 string back to a Uint8Array; returns an empty array on failure. */
function base64ToUint8(val: unknown): Uint8Array {
  if (typeof val !== 'string') return new Uint8Array(0);
  try {
    return Uint8Array.from(atob(val), (c) => c.charCodeAt(0));
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
    createdAt: entry.createdAt,
  };
}

/** Build the sensitive payload object to encrypt (file bytes base64-encoded). */
export function encodeOutboxSensitive(entry: OutboxEntry): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (entry.text !== undefined) payload.text = entry.text;
  if (entry.replyTo) payload.replyTo = entry.replyTo;
  if (entry.media) {
    const { fileBytes, ...rest } = entry.media;
    payload.media = {
      ...rest,
      ...(fileBytes && fileBytes.length > 0 ? { fileBytesB64: uint8ToBase64(fileBytes) } : {}),
    };
  }
  return payload;
}

/** Reconstruct a full {@link OutboxEntry} from its clear columns and decrypted payload. */
export function decodeOutboxEntry(clear: OutboxClearColumns, payload: any): OutboxEntry {
  let media: OutboxEntry['media'];
  if (payload?.media) {
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
    createdAt: clear.createdAt,
    text: typeof payload?.text === 'string' ? payload.text : undefined,
    replyTo: payload?.replyTo,
    media,
  };
}

/** Apply a partial patch to an entry, returning a new merged entry. */
export function mergeOutboxEntry(entry: OutboxEntry, patch: Partial<OutboxEntry>): OutboxEntry {
  const merged = { ...entry, ...patch };
  if (patch.media) merged.media = { ...entry.media, ...patch.media } as OutboxEntry['media'];
  return merged;
}
