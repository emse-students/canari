import * as crypto from 'crypto';

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
