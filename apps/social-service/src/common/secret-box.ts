import * as crypto from 'crypto';

/**
 * Encryption at rest of a THIRD PARTY's secret that this server must read back itself (today: an
 * association's Lydia Business private token, migration 100). Not end-to-end - the server holds the
 * key, by necessity, since it verifies callbacks with the plaintext - but a database dump, a backup
 * or the dev copy of production's rows carries ciphertext only.
 *
 * AES-256-GCM (node's `crypto`, no hand-rolled primitive) under a key derived by HKDF-SHA256 from
 * LYDIA_KEY_ENCRYPTION_SECRET with a per-purpose `info`, a fresh 96-bit IV per seal, and the caller's
 * `context` as additional authenticated data: a ciphertext opens only for the context it was sealed
 * for, so one copied to another row, or kept across a change of what it belongs to, fails to open.
 *
 * Format: `v1.` + base64url(iv || tag || ciphertext). The version prefix is what a later format reads
 * to tell the two apart (durable-rules: an at-rest envelope change ships its reader for the previous
 * format in the same commit).
 */

/** The environment variable holding the secret the key is derived from (32+ characters). */
export const SECRET_BOX_ENV = 'LYDIA_KEY_ENCRYPTION_SECRET';
/** Shortest secret accepted: the same floor `render-env.sh` refuses below at deploy time. */
export const SECRET_BOX_MIN_SECRET_LENGTH = 32;

const VERSION = 'v1.';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Thrown when no usable secret is configured: nothing can be sealed or opened, by design. */
export class SecretBoxUnavailableError extends Error {
  constructor() {
    super(
      `${SECRET_BOX_ENV} is not set or shorter than ${SECRET_BOX_MIN_SECRET_LENGTH} characters`
    );
    this.name = 'SecretBoxUnavailableError';
  }
}

/** Thrown when a ciphertext does not open: tampered, sealed for another context, or another secret. */
export class SecretBoxOpenError extends Error {
  constructor(reason: string) {
    super(`secret-box: ${reason}`);
    this.name = 'SecretBoxOpenError';
  }
}

/** The 32-byte key for `purpose`, derived from the configured secret; throws when there is none. */
function deriveKey(purpose: string): Buffer {
  const secret = process.env[SECRET_BOX_ENV] ?? '';
  if (secret.length < SECRET_BOX_MIN_SECRET_LENGTH) throw new SecretBoxUnavailableError();
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), `canari/${purpose}`, 32));
}

/** True when a usable secret is configured, so a write can be refused BEFORE anything is stored. */
export function isSecretBoxConfigured(): boolean {
  return (process.env[SECRET_BOX_ENV] ?? '').length >= SECRET_BOX_MIN_SECRET_LENGTH;
}

/** Seals `plaintext` for `purpose` (which key) and `context` (what it belongs to). */
export function sealSecret(purpose: string, context: string, plaintext: string): string {
  const key = deriveKey(purpose);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return VERSION + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** Opens what `sealSecret` produced for the same `purpose` and `context`; throws otherwise. */
export function openSecret(purpose: string, context: string, sealed: string): string {
  if (!sealed.startsWith(VERSION)) throw new SecretBoxOpenError('unknown format');
  const key = deriveKey(purpose);
  const raw = Buffer.from(sealed.slice(VERSION.length), 'base64url');
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new SecretBoxOpenError('truncated');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretBoxOpenError('authentication failed');
  }
}
