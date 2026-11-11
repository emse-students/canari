/**
 * `MediaMsg.loudness` (field 18, owner 2026-11-11) must cross the version boundary both ways: an
 * OLD reader (the schema before the field, parsed at runtime by protobufjs, as
 * `codec.reelMessage.test.ts` does) decodes a new message unharmed, and a new reader given an old
 * message gets no measurement - the video then plays as it always did.
 */
import { describe, expect, it } from 'vitest';
import protobuf from 'protobufjs';
import { canari } from './canari.js';
import { mediaLoudnessFromProto, mediaLoudnessProtoField } from './codec';
import { mkMediaEnvelope, parseEnvelope, serializeEnvelope } from '$lib/envelope';
import type { MediaRef } from '$lib/media';

const OldMediaMsg = protobuf
  .parse(
    `syntax = "proto3";
message MediaMsg {
  int32  kind = 1;
  string media_id = 2;
  bytes  key = 3;
  bytes  iv = 4;
  string mime_type = 5;
  uint32 size = 6;
  uint32 duration_ms = 15;
}`
  )
  .root.lookupType('MediaMsg');

const base = {
  kind: canari.MediaKind.MEDIA_KIND_VIDEO,
  mediaId: 'media-1',
  key: new Uint8Array(32).fill(7),
  iv: new Uint8Array(12).fill(9),
  mimeType: 'video/mp4',
  size: 4096,
  durationMs: 12_000,
};

const measured = { integratedLufs: -21.5, samplePeakDbfs: -2.25 };

describe('MediaMsg.loudness', () => {
  it('round-trips through the current schema', () => {
    const bytes = canari.MediaMsg.encode({
      ...base,
      ...mediaLoudnessProtoField(measured),
    }).finish();
    const read = mediaLoudnessFromProto(canari.MediaMsg.decode(bytes));
    expect(read.loudness?.integratedLufs).toBeCloseTo(-21.5, 4);
    expect(read.loudness?.samplePeakDbfs).toBeCloseTo(-2.25, 4);
  });

  it('an OLD reader decodes a measured message and keeps every field it knows', () => {
    const bytes = canari.MediaMsg.encode({
      ...base,
      ...mediaLoudnessProtoField(measured),
    }).finish();
    const old = OldMediaMsg.toObject(OldMediaMsg.decode(bytes)) as Record<string, unknown>;
    expect(old.mediaId).toBe('media-1');
    expect(old.durationMs).toBe(12_000);
  });

  it('a message with no measurement encodes byte for byte as before, and reads none', () => {
    const before = canari.MediaMsg.encode(base).finish();
    const now = canari.MediaMsg.encode({ ...base, ...mediaLoudnessProtoField(undefined) }).finish();
    expect(now).toEqual(before);
    expect(mediaLoudnessFromProto(canari.MediaMsg.decode(now))).toEqual({});
  });

  it('a value no real signal gives is dropped at the read', () => {
    const bytes = canari.MediaMsg.encode({
      ...base,
      loudness: { integratedLufs: -95, samplePeakDbfs: -3 },
    }).finish();
    expect(mediaLoudnessFromProto(canari.MediaMsg.decode(bytes))).toEqual({});
    const crafted = canari.MediaMsg.encode({
      ...base,
      loudness: { integratedLufs: 29, samplePeakDbfs: 0 },
    }).finish();
    expect(mediaLoudnessFromProto(canari.MediaMsg.decode(crafted))).toEqual({});
  });

  it('survives the stored envelope (JSON) a conversation row is drawn from', () => {
    const ref: MediaRef = {
      type: 'video',
      mediaId: 'media-1',
      key: 'ab',
      iv: 'cd',
      mimeType: 'video/mp4',
      size: 4096,
      loudness: measured,
    };
    const parsed = parseEnvelope(serializeEnvelope(mkMediaEnvelope(ref)));
    expect(parsed.kind === 'media' && parsed.media.loudness).toEqual(measured);
  });
});
