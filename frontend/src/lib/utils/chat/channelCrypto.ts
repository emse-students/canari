import { channelKeyManager } from '$lib/crypto/ChannelKeyVault';
import { ChannelService, type ChannelBootstrapDto } from '$lib/services/ChannelService';

const channelService = new ChannelService();

function normalizeChannelId(channelId: string): string {
  return String(channelId).replace(/^channel_/, '');
}

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
