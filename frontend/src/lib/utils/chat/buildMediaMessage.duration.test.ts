/**
 * A CONVERSATION'S VIDEO DECLARES ITS LENGTH (owner, 2026-11-10: its player read `0:23 / 0:00`).
 * The length rides in `MediaMsg.duration_ms` - the optional field CanaReels-in-chat added, which a
 * client older than it skips as an unknown field and a client since reads only on a reel's tile -
 * WITHOUT the reel intent, so the message stays an ordinary video for every client.
 */
import { describe, expect, it } from 'vitest';
import { buildMediaMessage } from './outbox';
import { decodeAppMessage, mediaReelFromProto } from '$lib/proto/codec';
import { parseEnvelope } from '$lib/envelope';

const ref = { mediaId: 'm1', key: '00'.repeat(32), iv: '00'.repeat(12) };

function build(durationMs?: number) {
  return buildMediaMessage(
    { id: 'msg-1', sentAt: 1 },
    {
      kind: 'video',
      mimeType: 'video/mp4',
      size: 10,
      fileName: 'clip.mp4',
      width: 720,
      height: 1280,
      ...(durationMs ? { durationMs } : {}),
    } as never,
    ref as never
  );
}

describe('buildMediaMessage - the length of an ordinary video', () => {
  it('is declared in the proto and the envelope, with no reel intent', () => {
    const { proto, content } = build(23_400);
    const media = decodeAppMessage(proto)!.media!;
    expect(mediaReelFromProto(media)).toEqual({ durationMs: 23_400 });
    const envelope = parseEnvelope(content);
    expect(envelope.kind).toBe('media');
    if (envelope.kind !== 'media') return;
    expect(envelope.media.durationMs).toBe(23_400);
    expect(envelope.media.intent).toBeUndefined();
  });

  it('is absent, byte for byte as before, when nothing was measured', () => {
    const media = decodeAppMessage(build().proto)!.media!;
    expect(mediaReelFromProto(media)).toEqual({});
  });
});
