import { channelKeyManager } from '$lib/crypto/ChannelKeyVault';
import { ChannelService, type ChannelBootstrapDto } from '$lib/services/ChannelService';

const channelService = new ChannelService();

/** Strip the `channel_` prefix from a channel ID so the raw UUID is passed to the backend. */
function normalizeChannelId(channelId: string): string {
  return String(channelId).replace(/^channel_/, '');
}

/** True for community channel conversations (`channel_<uuid>`). */
export function isChannelConversationId(conversationId: string): boolean {
  return String(conversationId).startsWith('channel_');
}

/** Return true when an encryption error indicates the local channel key is stale and must be refreshed from the server before retrying. */
function shouldRefreshChannelKey(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('No key for epoch') ||
    message.includes('Missing key for epoch') ||
    message.includes('Sync required') ||
    message.includes('Stale or invalid keyVersion') ||
    message.includes('keyVersion is required for channel messages')
  );
}

/**
 * Load (or re-load) the channel's current epoch key into the in-memory ChannelKeyVault.
 *
 * If `bootstrap` is provided (e.g. already fetched by the caller), it is used directly;
 * otherwise the latest bootstrap is fetched from the server via ChannelService.
 * The raw key material is decoded from base64 and stored under its keyVersion in the vault
 * so that subsequent encryptMessage / decryptMessage calls can find it.
 */
export async function hydrateChannelBootstrap(
  channelId: string,
  bootstrap?: ChannelBootstrapDto | null
): Promise<ChannelBootstrapDto> {
  const rawChannelId = normalizeChannelId(channelId);
  const resolvedBootstrap =
    bootstrap ?? (await channelService.getChannelKeyBootstrap(rawChannelId));

  if (resolvedBootstrap.channelId !== rawChannelId) {
    throw new Error(
      `Channel bootstrap mismatch: expected ${rawChannelId}, got ${resolvedBootstrap.channelId}`
    );
  }

  const rawKeyMat = Uint8Array.from(atob(resolvedBootstrap.newEpochBaseKey), (char) =>
    char.charCodeAt(0)
  );
  await channelKeyManager.getVault(rawChannelId).rotateKey(resolvedBootstrap.keyVersion, rawKeyMat);

  return resolvedBootstrap;
}

/**
 * Encrypt `payloadBytes` with the channel's current epoch key and POST the ciphertext to the backend.
 *
 * On first attempt, uses the cached key from the vault.  If that fails with a "stale key" error
 * (e.g. the epoch rotated while this tab was open), the bootstrap is refreshed automatically and
 * the send is retried exactly once.
 */
export async function sendEncryptedChannelMessage(
  channelId: string,
  payloadBytes: Uint8Array,
  messageId?: string
): Promise<void> {
  const rawChannelId = normalizeChannelId(channelId);

  const attempt = async () => {
    const encrypted = await channelKeyManager.encryptMessage(rawChannelId, payloadBytes);
    await channelService.sendMessage(rawChannelId, {
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      keyVersion: encrypted.keyVersion,
      ...(messageId ? { messageId } : {}),
    });
  };

  try {
    await attempt();
  } catch (error) {
    if (!shouldRefreshChannelKey(error)) {
      throw error;
    }

    await hydrateChannelBootstrap(rawChannelId);
    await attempt();
  }
}
