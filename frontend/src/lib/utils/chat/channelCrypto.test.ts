/**
 * The retry decision in `sendEncryptedChannelMessage`.
 *
 * One epoch rotation is worth exactly one refresh-and-retry, and the decision is taken on the TYPE
 * of the failure and on the server's stable `code` - never on the sentence either of them carries.
 * The last two cases are the point of the file: an error whose prose matches the wording the old
 * implementation looked for must NOT be retried.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMessage = vi.fn();
const getChannelKeyBootstrap = vi.fn();

vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('$lib/services/ChannelService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/services/ChannelService')>();
  return {
    ...actual,
    ChannelService: class MockChannelService {
      sendMessage = sendMessage;
      getChannelKeyBootstrap = getChannelKeyBootstrap;
    },
  };
});

const encryptMessage = vi.fn();

vi.mock('$lib/crypto/ChannelKeyVault', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/crypto/ChannelKeyVault')>();
  return {
    ...actual,
    channelKeyManager: { encryptMessage },
  };
});

vi.mock('$lib/utils/chat/channelKeyMirror', () => ({
  importChannelEpochKey: vi.fn().mockResolvedValue(undefined),
}));

const { ChannelApiError } = await import('$lib/services/ChannelService');
const { ChannelKeyUnavailableError } = await import('$lib/crypto/ChannelKeyVault');
const { sendEncryptedChannelMessage } = await import('$lib/utils/chat/channelCrypto');

const CHANNEL = 'channel_11111111-2222-3333-4444-555555555555';
const RAW = '11111111-2222-3333-4444-555555555555';
const PAYLOAD = new Uint8Array([1, 2, 3]);

/** A successful encryption under `keyVersion`, as the vault would answer it. */
function encrypted(keyVersion: number) {
  return { ciphertext: 'Y2lwaGVy', nonce: 'bm9uY2U=', keyVersion };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  encryptMessage.mockResolvedValue(encrypted(4));
  sendMessage.mockResolvedValue(undefined);
  getChannelKeyBootstrap.mockResolvedValue({
    channelId: RAW,
    keyVersion: 5,
    newEpochBaseKey: btoa(String.fromCharCode(...new Uint8Array(32))),
  });
});

describe('sendEncryptedChannelMessage', () => {
  it('sends once and refreshes nothing when the epoch is current', async () => {
    await sendEncryptedChannelMessage(CHANNEL, PAYLOAD);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(getChannelKeyBootstrap).not.toHaveBeenCalled();
  });

  it('refreshes and retries once when the vault holds no key for the epoch', async () => {
    encryptMessage
      .mockRejectedValueOnce(new ChannelKeyUnavailableError(4, []))
      .mockResolvedValueOnce(encrypted(5));

    await sendEncryptedChannelMessage(CHANNEL, PAYLOAD);

    expect(getChannelKeyBootstrap).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ keyVersion: 5 });
  });

  it('refreshes and retries once when the server calls the keyVersion stale', async () => {
    sendMessage.mockRejectedValueOnce(
      new ChannelApiError(403, 'STALE_CHANNEL_KEY_VERSION', 'anything at all')
    );
    encryptMessage.mockResolvedValueOnce(encrypted(4)).mockResolvedValueOnce(encrypted(5));

    await sendEncryptedChannelMessage(CHANNEL, PAYLOAD);

    expect(getChannelKeyBootstrap).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('gives up after exactly one retry', async () => {
    sendMessage.mockRejectedValue(
      new ChannelApiError(403, 'STALE_CHANNEL_KEY_VERSION', 'still stale')
    );

    await expect(sendEncryptedChannelMessage(CHANNEL, PAYLOAD)).rejects.toBeInstanceOf(
      ChannelApiError
    );
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(getChannelKeyBootstrap).toHaveBeenCalledTimes(1);
  });

  it('does not retry a refusal that a fresh key cannot fix', async () => {
    const refusal = new ChannelApiError(403, null, 'Not allowed to post in this channel');
    sendMessage.mockRejectedValueOnce(refusal);

    await expect(sendEncryptedChannelMessage(CHANNEL, PAYLOAD)).rejects.toBe(refusal);
    expect(getChannelKeyBootstrap).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not retry a missing keyVersion, which a refresh cannot supply', async () => {
    const refusal = new ChannelApiError(
      400,
      'CHANNEL_KEY_VERSION_REQUIRED',
      'keyVersion is required for channel messages'
    );
    sendMessage.mockRejectedValueOnce(refusal);

    await expect(sendEncryptedChannelMessage(CHANNEL, PAYLOAD)).rejects.toBe(refusal);
    expect(getChannelKeyBootstrap).not.toHaveBeenCalled();
  });

  it('ignores an error that merely reads like a stale key', async () => {
    // The five sentences the old implementation matched on, carried by an untyped Error. Matching
    // prose meant any layer could impersonate a stale key by wording its failure the same way.
    for (const sentence of [
      'No key for epoch 4. Available: none',
      'Missing key for epoch 4. Sync required.',
      'Stale or invalid keyVersion (4) for channel epoch 5',
      'keyVersion is required for channel messages',
    ]) {
      vi.clearAllMocks();
      encryptMessage.mockResolvedValue(encrypted(4));
      const refusal = new Error(sentence);
      sendMessage.mockRejectedValueOnce(refusal);

      await expect(sendEncryptedChannelMessage(CHANNEL, PAYLOAD)).rejects.toBe(refusal);
      expect(getChannelKeyBootstrap).not.toHaveBeenCalled();
    }
  });
});
