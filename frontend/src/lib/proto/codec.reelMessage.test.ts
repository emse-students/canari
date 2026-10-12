/**
 * `MediaMsg.intent`, `duration_ms` and `expires_at_ms` (fields 14-16, CanaReels in a conversation)
 * must cross the version boundary in BOTH directions, and an intent value nobody knows yet must
 * read as an ordinary attachment. The OLD reader is the schema before the fields, parsed at runtime
 * by protobufjs, exactly as `codec.mediaPlaceholder.test.ts` does.
 */
import { describe, expect, it } from 'vitest';
import protobuf from 'protobufjs';
import { canari } from './canari.js';
import { mediaReelFromProto, mediaReelProtoFields } from './codec';
import { parseEnvelope, serializeEnvelope, mkMediaEnvelope } from '$lib/envelope';
import type { MediaRef } from '$lib/media';

const OLD_SCHEMA = `
syntax = "proto3";
message MediaMsg {
  int32  kind = 1;
  string media_id = 2;
  bytes  key = 3;
  bytes  iv = 4;
  string mime_type = 5;
  uint32 size = 6;
  string file_name = 7;
  string caption = 8;
  uint32 width = 9;
  uint32 height = 10;
  bool   voice_note = 11;
  int32  encoding = 12;
  bytes  placeholder = 13;
}`;
const OldMediaMsg = protobuf.parse(OLD_SCHEMA).root.lookupType('MediaMsg');

const base = {
  kind: canari.MediaKind.MEDIA_KIND_VIDEO,
  mediaId: 'media-1',
  key: new Uint8Array(32).fill(7),
  iv: new Uint8Array(12).fill(9),
  mimeType: 'video/mp4',
  size: 4096,
  width: 540,
  height: 960,
};

const declaration: Pick<MediaRef, 'intent' | 'durationMs' | 'expiresAtMs'> = {
  intent: 'reel-message',
  durationMs: 42_000,
  expiresAtMs: 1_790_000_000_000,
};

function encode(extra: Record<string, unknown>): Uint8Array {
  return canari.MediaMsg.encode(canari.MediaMsg.create({ ...base, ...extra })).finish();
}

describe('MediaMsg reel declaration across versions', () => {
  it('a NEW reel message is read by an OLD client as a plain video, every old field intact', () => {
    const old = OldMediaMsg.toObject(
      OldMediaMsg.decode(encode(mediaReelProtoFields(declaration)))
    ) as Record<string, unknown>;
    expect(old.mediaId).toBe('media-1');
    expect(old.kind).toBe(canari.MediaKind.MEDIA_KIND_VIDEO);
    expect(old.mimeType).toBe('video/mp4');
    expect(old.width).toBe(540);
    expect(old).not.toHaveProperty('intent');
  });

  it('an OLD message is read by a NEW client as an ordinary attachment', () => {
    const bytes = OldMediaMsg.encode(OldMediaMsg.fromObject(base)).finish();
    expect(mediaReelFromProto(canari.MediaMsg.decode(bytes))).toEqual({});
  });

  it('a NEW reel message round-trips intent, length and expiry hint', () => {
    const decoded = canari.MediaMsg.decode(encode(mediaReelProtoFields(declaration)));
    expect(mediaReelFromProto(decoded)).toEqual(declaration);
  });

  it('an ordinary ref encodes byte for byte as before the fields existed', () => {
    const withHelper = encode(mediaReelProtoFields({}));
    const before = OldMediaMsg.encode(OldMediaMsg.fromObject(base)).finish();
    expect([...withHelper]).toEqual([...before]);
  });

  it('an intent value this client does not know reads as an ordinary attachment, never an error', () => {
    // 2 is reserved for a later view-once mode; 99 is whatever a future writer invents.
    for (const unknown of [2, 99]) {
      const decoded = canari.MediaMsg.decode(encode({ intent: unknown, durationMs: 5000 }));
      const read = mediaReelFromProto(decoded);
      expect(read.intent).toBeUndefined();
      expect(read.durationMs).toBe(5000);
    }
  });

  it('writes nothing for a zero or negative length or expiry', () => {
    expect(mediaReelProtoFields({ durationMs: 0, expiresAtMs: -1 })).toEqual({});
  });
});

describe('the reel declaration in the stored JSON envelope', () => {
  const ref: MediaRef = {
    type: 'video',
    mediaId: 'media-1',
    key: '00'.repeat(32),
    iv: '00'.repeat(12),
    mimeType: 'video/mp4',
    size: 1,
    width: 540,
    height: 960,
  };

  it('survives a store and a reload', () => {
    const env = parseEnvelope(serializeEnvelope(mkMediaEnvelope({ ...ref, ...declaration })));
    expect(env.kind === 'media' && env.media).toMatchObject(declaration);
  });

  it('is absent from an envelope stored before it existed; an unknown intent or a bad number is dropped', () => {
    const old = parseEnvelope(serializeEnvelope(mkMediaEnvelope(ref)));
    expect(old.kind === 'media' && old.media.intent).toBeUndefined();
    const raw = JSON.stringify({
      kind: 'media',
      media: { ...ref, intent: 'view-once', durationMs: 'long', expiresAtMs: -4 },
    });
    const bad = parseEnvelope(raw);
    expect(bad.kind === 'media' && bad.media.intent).toBeUndefined();
    expect(bad.kind === 'media' && bad.media.durationMs).toBeUndefined();
    expect(bad.kind === 'media' && bad.media.expiresAtMs).toBeUndefined();
  });
});
