/**
 * OPENS ONE SEALED LIVE CHAT LINE ON THE SERVER - for ONE purpose: checking the plaintext a REPORTER
 * hands over against the line the author sealed (WP-L8b). The server always held the live key (C12:
 * the seal protects against the store and the database's readers, never against social-service);
 * this is the first and only place it uses it on a message, and only for a line a member reported
 * while the live's row still exists. The key is not kept beyond that row, where it is stored sealed
 * (migration 110) and reaches this file only through `openLiveKey` (`live-key-at-rest.ts`).
 *
 * The format is the client's, `frontend/src/lib/live/liveChatCrypto.ts`, v1:
 *
 *   sealed = iv(12) || ciphertext || tag(16)
 *   plain  = the message as UTF-8
 *   AAD    = "canari-live-chat-v1" || 0x00 || liveId (16 raw bytes) || clientId (16 raw bytes)
 *            || authorId (UTF-8, trimmed, lower case)
 *
 * Pinned against the client by a shared known-answer vector (`live-chat-seal.spec.ts` and
 * `liveChatCrypto.test.ts` open the same bytes). NEVER LOGS the key, the plaintext or the ciphertext.
 */
import { createDecipheriv } from 'crypto';

const FORMAT_LABEL = 'canari-live-chat-v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.toLowerCase().replaceAll('-', ''), 'hex');
}

/** The v1 AAD, exactly as the client builds it. */
export function liveChatAad(liveId: string, clientId: string, authorId: string): Buffer {
  return Buffer.concat([
    Buffer.from(FORMAT_LABEL, 'utf8'),
    Buffer.from([0x00]),
    uuidBytes(liveId),
    uuidBytes(clientId),
    Buffer.from(authorId.trim().toLowerCase(), 'utf8'),
  ]);
}

/**
 * The line's text, or null when it does not open: too short, a GCM refusal (wrong key, live, author,
 * clientId, or a changed byte), or not UTF-8. A null is typed by the caller, never thrown as prose.
 */
export function openLiveChatLine(
  keyHex: string,
  liveId: string,
  clientId: string,
  authorId: string,
  sealed: Buffer
): string | null {
  if (sealed.length < IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(keyHex, 'hex'),
      sealed.subarray(0, IV_BYTES)
    );
    decipher.setAAD(liveChatAad(liveId, clientId, authorId));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]);
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    return null;
  }
}
