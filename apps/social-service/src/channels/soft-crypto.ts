import * as crypto from 'crypto';

/**
 * Derive a 32-byte AES-256 channel key using HKDF-SHA-256.
 *
 * The salt is SHA-256("workspaceId:channelId:version") so each epoch / channel combination
 * produces a unique key even when the same `secret` is shared across the workspace.
 * The info string "canari-channel-e2ee-v1" domain-separates these keys from any other
 * HKDF derivations that might use the same input keying material.
 */
function deriveChannelKey(
  secret: string,
  workspaceId: string,
  channelId: string,
  version: number
): Buffer {
  const salt = crypto
    .createHash('sha256')
    .update(`${workspaceId}:${channelId}:${version}`)
    .digest();
  const raw = crypto.hkdfSync(
    'sha256',
    Buffer.from(secret),
    salt,
    Buffer.from('canari-channel-e2ee-v1'),
    32
  );
  return Buffer.from(raw);
}

/**
 * Encrypt a plaintext string with AES-256-GCM using a key derived from `secret`, `workspaceId`, `channelId`, and `keyVersion`.
 *
 * A 12-byte random nonce is generated per call.  The 16-byte GCM authentication tag is appended
 * to the ciphertext before base64 encoding.  Both the `ciphertext` and `nonce` must be stored and
 * sent together so the receiver can decrypt with decryptSoft.
 */
export function encryptSoft(params: {
  secret: string;
  workspaceId: string;
  channelId: string;
  keyVersion: number;
  plaintext: string;
}): { ciphertext: string; nonce: string } {
  const { secret, workspaceId, channelId, keyVersion, plaintext } = params;
  const key = deriveChannelKey(secret, workspaceId, channelId, keyVersion);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
    nonce: iv.toString('base64'),
  };
}

/**
 * Decrypt a ciphertext produced by encryptSoft.
 *
 * The base64-encoded `ciphertext` is expected to end with a 16-byte GCM authentication tag
 * (appended by encryptSoft).  The tag is split off before the AES-256-GCM decipher is created.
 * Throws if the tag does not verify (tampered data or wrong key).
 */
export function decryptSoft(params: {
  secret: string;
  workspaceId: string;
  channelId: string;
  keyVersion: number;
  ciphertext: string;
  nonce: string;
}): string {
  const { secret, workspaceId, channelId, keyVersion, ciphertext, nonce } = params;
  const key = deriveChannelKey(secret, workspaceId, channelId, keyVersion);
  const raw = Buffer.from(ciphertext, 'base64');
  const iv = Buffer.from(nonce, 'base64');

  const data = raw.subarray(0, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}
