/**
 * What `sendEncryptedChannelMessage` puts on the wire, and what it refuses to.
 *
 * The retry this file used to be about is GONE, and its absence is the first thing asserted here.
 * It existed because the SERVER derived the channel key and could rotate its epoch out from under a
 * connected tab, so a send could fail for a reason a refresh repaired. Nothing rotates under a
 * sender any more: the session is this device's own, and the one thing that invalidates it - the
 * community's roster moving - is checked before the seal rather than discovered by a refusal after
 * it. A retry here would now re-send an identical body and fail identically.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMessage = vi.fn();
const sealChannelMessage = vi.fn();

vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('$lib/services/ChannelService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/services/ChannelService')>();
  return {
    ...actual,
    ChannelService: class MockChannelService {
      sendMessage = sendMessage;
    },
  };
});

vi.mock('$lib/utils/graine/channelSeal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/graine/channelSeal')>();
  return { ...actual, sealChannelMessage };
});

const { ChannelApiError } = await import('$lib/services/ChannelService');
const { GraineDistributionUnavailableError } = await import('$lib/utils/graine/seedDistribution');
const { sendEncryptedChannelMessage } = await import('$lib/utils/chat/channelCrypto');

const CHANNEL = 'channel_11111111-2222-3333-4444-555555555555';
const RAW = '11111111-2222-3333-4444-555555555555';
const PAYLOAD = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  sealChannelMessage.mockResolvedValue({
    ciphertext: 'Y2lwaGVy',
    nonce: 'bm9uY2U=',
    senderSessionId: 'sess-1',
    messageIndex: 7,
  });
  sendMessage.mockResolvedValue(undefined);
});

describe('sendEncryptedChannelMessage', () => {
  it('addresses the RAW channel id and carries the session and the index', async () => {
    await sendEncryptedChannelMessage(CHANNEL, PAYLOAD);

    expect(sealChannelMessage).toHaveBeenCalledWith(RAW, PAYLOAD);
    // Both fields, or the message is one nobody can open: the key is HKDF(seed, session, index).
    expect(sendMessage).toHaveBeenCalledWith(RAW, {
      ciphertext: 'Y2lwaGVy',
      nonce: 'bm9uY2U=',
      senderSessionId: 'sess-1',
      messageIndex: 7,
    });
  });

  it('sends index 0 as a number, never dropped as falsy', async () => {
    sealChannelMessage.mockResolvedValue({
      ciphertext: 'Y2lwaGVy',
      nonce: 'bm9uY2U=',
      senderSessionId: 'sess-1',
      messageIndex: 0,
    });

    await sendEncryptedChannelMessage(CHANNEL, PAYLOAD);

    // Index 0 is the first message of every session, and the server refuses a body without one.
    expect(sendMessage.mock.calls[0][1].messageIndex).toBe(0);
  });

  it('sends exactly once, whatever the server answers', async () => {
    const refusal = new ChannelApiError(403, 'FORBIDDEN', 'nope');
    sendMessage.mockRejectedValue(refusal);

    await expect(sendEncryptedChannelMessage(CHANNEL, PAYLOAD)).rejects.toBe(refusal);
    // No refresh, no second attempt: there is no server-held key left to be behind.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sealChannelMessage).toHaveBeenCalledTimes(1);
  });

  it('never reaches the server when the seal itself refused', async () => {
    const refusal = new GraineDistributionUnavailableError('ws-1');
    sealChannelMessage.mockRejectedValue(refusal);

    await expect(sendEncryptedChannelMessage(CHANNEL, PAYLOAD)).rejects.toBe(refusal);
    // A community whose distribution group is not in hand cannot receive the seed, so a message
    // sealed under it would be unreadable by everyone - including its own author.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('attaches a message id, a poll and mentions only when it has them', async () => {
    await sendEncryptedChannelMessage(CHANNEL, PAYLOAD, 'msg-1', undefined, []);

    const body = sendMessage.mock.calls[0][1];
    expect(body.messageId).toBe('msg-1');
    // An empty mention list is not a mention list: sending it would route every member's
    // `mentions` notification level as though somebody had been named.
    expect('mentionedUserIds' in body).toBe(false);
    expect('poll' in body).toBe(false);
  });
});
