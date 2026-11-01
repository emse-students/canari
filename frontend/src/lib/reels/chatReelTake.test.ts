/**
 * THE ROWS OF ONE CHAT-REEL TAKE (RC-13): the take names exactly its sends, each send names its take
 * and holds no file, and the declaration is made at the press.
 */
import { buildChatReelTake } from './chatReelTake';
import { REEL_TAKE_QUEUE } from '$lib/db/outboxCodec';
import { CHAT_REEL_RETENTION_MS } from './chatReelWriter';
import { parseEnvelope } from '$lib/envelope';

const BYTES = new Uint8Array([1, 2, 3, 4]);

function build(targets = 2) {
  return buildChatReelTake({
    takeId: 'take',
    sentAt: 1_000,
    senderId: 'me',
    bytes: BYTES,
    mimeType: 'video/webm',
    fileName: 'take.webm',
    placeholder: 'thumb',
    targets: Array.from({ length: targets }, (_, i) => ({
      messageId: `m${i}`,
      groupId: `g${i}`,
      conversationKey: `G${i}`,
    })),
  });
}

describe('buildChatReelTake', () => {
  it('writes the file on the take only, which names exactly its sends', () => {
    const { take, sends } = build();
    expect(take.kind).toBe('reel-take');
    expect(take.conversationId).toBe(REEL_TAKE_QUEUE);
    expect(take.media?.fileBytes).toBe(BYTES);
    expect(take.media?.prepare).toBe('chat-reel');
    expect(take.take?.sends).toEqual([
      { id: 'm0', conversationId: 'g0' },
      { id: 'm1', conversationId: 'g1' },
    ]);
    for (const [i, send] of sends.entries()) {
      expect(send.entry.kind).toBe('media');
      expect(send.entry.conversationId).toBe(`g${i}`);
      expect(send.entry.media?.takeId).toBe('take');
      expect(send.entry.media?.fileBytes).toBeUndefined();
      expect(send.entry.media?.prepare).toBeUndefined();
      expect(send.message.conversationId).toBe(`g${i}`);
    }
  });

  it('declares the reel at the press: its intent, and 30 days from it', () => {
    const { take, sends } = build(1);
    expect(take.media?.intent).toBe('reel-message');
    expect(take.media?.expiresAtMs).toBe(1_000 + CHAT_REEL_RETENTION_MS);
    expect(sends[0].entry.media?.expiresAtMs).toBe(1_000 + CHAT_REEL_RETENTION_MS);
    const envelope = parseEnvelope(sends[0].message.content);
    expect(envelope.kind).toBe('media');
    const media = envelope.kind === 'media' ? envelope.media : undefined;
    expect(media?.mediaId).toBe('');
    expect(media?.placeholder).toBe('thumb');
  });

  it('refuses a take nobody is sent to', () => {
    expect(() => build(0)).toThrow();
  });
});
