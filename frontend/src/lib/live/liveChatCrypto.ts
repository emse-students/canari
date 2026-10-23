/**
 * THE LIVE CHAT SEAL, FORMAT v1 (WP-L6, decision C12 in docs/wiki/services/lives.md) - what a member
 * puts in `POST /api/lives/:id/messages` and what every viewer opens from the poll's `chat` block.
 *
 * The segment seal's construction (`liveCrypto.ts`: AES-256-GCM, WebCrypto, the live key, a fresh
 * random 12-byte IV), with its own label and binding:
 *
 *   sealed = iv(12) || ciphertext || tag(16)            sent as base64
 *   plain  = the message as UTF-8, plain text, nothing else
 *   AAD    = ASCII "canari-live-chat-v1" || 0x00 || liveId (16 raw bytes) || clientId (16 raw bytes)
 *            || authorId (UTF-8, lower case)
 *
 * The AAD binds a message to its LIVE, its idempotence key and its AUTHOR: a server or a store that
 * served one member's ciphertext under another member's name, or replayed it on another live, makes
 * it FAIL to open, and the viewer drops it. A distinct label keeps a chat message and a segment from
 * ever being read as one another under the same key. Unlike a segment, a chat line never reaches the
 * media store: it lives only in social-service's database, beside the live key, so the seal gives NO
 * confidentiality against whoever holds that database or its backups, nor against social-service.
 * What it gives is the binding above.
 *
 * Owed an adversarial crypto review before its pull request leaves draft, as the segment seal was.
 * NEVER LOGS key material, plaintext or ciphertext - lengths only.
 */
import { Log } from '$lib/utils/Log';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import { importLiveKey, uuidBytes } from './liveCrypto';

const TAG = 'LiveChatCrypto';

/** The format label at the head of the AAD; a v2 changes it. */
const FORMAT_LABEL = 'canari-live-chat-v1';
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_HEX_RE = /^[0-9a-f]{64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A message that does not open. `malformed`: not base64, or too short to hold an IV and a tag.
 * `unauthentic`: GCM refused it - wrong key, live, author, clientId or version, or a changed byte.
 * `not-text`: it opened, and is not UTF-8. Typed at the throw: a viewer drops the line, never more.
 */
export class LiveChatOpenError extends Error {
  readonly reason: 'malformed' | 'unauthentic' | 'not-text';

  constructor(reason: 'malformed' | 'unauthentic' | 'not-text', sealedChars: number) {
    super(`live chat message (${sealedChars} chars) did not open: ${reason}`);
    this.name = 'LiveChatOpenError';
    this.reason = reason;
  }
}

/** Refuses an argument no caller should pass - a programming error, so a RangeError. */
function checkArgs(keyHex: string, liveId: string, clientId: string, authorId: string): void {
  if (!KEY_HEX_RE.test(keyHex)) throw new RangeError('live key must be 64 hex characters');
  if (!UUID_RE.test(liveId)) throw new RangeError('live id must be a uuid');
  if (!UUID_RE.test(clientId)) throw new RangeError('client id must be a uuid');
  if (authorId.trim() === '') throw new RangeError('author id must not be empty');
}

/** The v1 AAD. Every id lower case, as the server stores and serves them. */
function buildAad(liveId: string, clientId: string, authorId: string): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const label = enc.encode(FORMAT_LABEL);
  const author = enc.encode(authorId.trim().toLowerCase());
  const aad = new Uint8Array(label.length + 1 + 16 + 16 + author.length);
  let at = 0;
  aad.set(label, at);
  at += label.length;
  aad[at++] = 0x00;
  aad.set(uuidBytes(liveId.toLowerCase()), at);
  at += 16;
  aad.set(uuidBytes(clientId.toLowerCase()), at);
  at += 16;
  aad.set(author, at);
  return aad;
}

/**
 * Seals one message's text for `POST /api/lives/:id/messages`, as base64. A fresh IV every call -
 * so a retry re-sends the SAME string it was given, never a re-seal (the server's repeat is
 * idempotent for identical bytes only, and other bytes under the same clientId are a 409).
 */
export async function sealLiveChatMessage(
  keyHex: string,
  liveId: string,
  clientId: string,
  authorId: string,
  text: string
): Promise<string> {
  checkArgs(keyHex, liveId, clientId, authorId);
  const plain = new TextEncoder().encode(text);
  Log.d(TAG, { op: 'seal', plainBytes: plain.byteLength });
  const key = await importLiveKey(keyHex, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: buildAad(liveId, clientId, authorId), tagLength: 128 },
      key,
      plain
    )
  );
  const sealed = new Uint8Array(IV_BYTES + body.byteLength);
  sealed.set(iv, 0);
  sealed.set(body, IV_BYTES);
  return toBase64(sealed);
}

/**
 * Opens one message from the poll back to its text. Throws {@link LiveChatOpenError} for anything
 * that is not exactly what `authorId` sealed for THIS live under THIS clientId.
 */
export async function openLiveChatMessage(
  keyHex: string,
  liveId: string,
  clientId: string,
  authorId: string,
  sealedB64: string
): Promise<string> {
  checkArgs(keyHex, liveId, clientId, authorId);
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(sealedB64);
  } catch {
    throw new LiveChatOpenError('malformed', sealedB64.length);
  }
  if (bytes.byteLength < IV_BYTES + GCM_TAG_BYTES) {
    throw new LiveChatOpenError('malformed', sealedB64.length);
  }
  const key = await importLiveKey(keyHex, 'decrypt');
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes.slice(0, IV_BYTES),
        additionalData: buildAad(liveId, clientId, authorId),
        tagLength: 128,
      },
      key,
      bytes.slice(IV_BYTES)
    );
  } catch (e) {
    Log.d(TAG, {
      op: 'open',
      refused: 'unauthentic',
      sealedChars: sealedB64.length,
      cause: e instanceof Error ? e.name : typeof e,
    });
    throw new LiveChatOpenError('unauthentic', sealedB64.length);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    throw new LiveChatOpenError('not-text', sealedB64.length);
  }
}
