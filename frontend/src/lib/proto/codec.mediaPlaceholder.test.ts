/**
 * `MediaMsg.placeholder` (field 13, 2026-10-02) must cross the version boundary in BOTH directions.
 *
 * The OLD reader is not imagined: it is the `MediaMsg` schema as it stood before the field, parsed at
 * runtime by protobufjs - the library the generated bindings are made with - so the test decodes the
 * new bytes exactly as a client still on the previous release does.
 */
import { describe, expect, it } from 'vitest';
import protobuf from 'protobufjs';
import { canari } from './canari.js';
import { mediaPlaceholderFromProto, mediaPlaceholderProtoField } from './codec';
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
}`;
const OldMediaMsg = protobuf.parse(OLD_SCHEMA).root.lookupType('MediaMsg');

// A real ThumbHash's length; the bytes only need to survive, not to decode.
const HASH = new Uint8Array([0x1b, 0x08, 0x0a, 0x0d, 0x82, 0x77, 0x88, 0x77, 0x87, 0x78, 0x87, 0x70]);

const base = {
  kind: 1,
  mediaId: 'media-1',
  key: new Uint8Array(32).fill(7),
  iv: new Uint8Array(12).fill(9),
  mimeType: 'image/webp',
  size: 2048,
  width: 1080,
  height: 1920,
};

describe('MediaMsg.placeholder across versions', () => {
  it('a NEW message is read by an OLD client with every field it knew intact', () => {
    const bytes = canari.MediaMsg.encode(
      canari.MediaMsg.create({ ...base, ...mediaPlaceholderProtoField('GwgKDYJ3iHeHeIdw') })
    ).finish();
    const old = OldMediaMsg.toObject(OldMediaMsg.decode(bytes)) as Record<string, unknown>;
    expect(old.mediaId).toBe('media-1');
    expect(old.width).toBe(1080);
    expect(old.height).toBe(1920);
    expect(old.mimeType).toBe('image/webp');
    expect(old).not.toHaveProperty('placeholder');
  });

  it('an OLD message is read by a NEW client as one with no placeholder', () => {
    const bytes = OldMediaMsg.encode(OldMediaMsg.fromObject(base)).finish();
    const decoded = canari.MediaMsg.decode(bytes);
    expect(decoded.width).toBe(1080);
    expect(mediaPlaceholderFromProto(decoded.placeholder)).toBeUndefined();
  });

  it('a NEW message round-trips its placeholder', () => {
    const b64 = btoa(String.fromCharCode(...HASH));
    const bytes = canari.MediaMsg.encode(
      canari.MediaMsg.create({ ...base, ...mediaPlaceholderProtoField(b64) })
    ).finish();
    expect(mediaPlaceholderFromProto(canari.MediaMsg.decode(bytes).placeholder)).toBe(b64);
  });

  it('a ref with no placeholder encodes byte for byte as before the field existed', () => {
    const withField = canari.MediaMsg.encode(
      canari.MediaMsg.create({ ...base, ...mediaPlaceholderProtoField(undefined) })
    ).finish();
    const before = OldMediaMsg.encode(OldMediaMsg.fromObject(base)).finish();
    expect([...withField]).toEqual([...before]);
  });
});

describe('MediaRef.placeholder in the stored JSON envelope', () => {
  const ref: MediaRef = {
    type: 'image',
    mediaId: 'media-1',
    key: '00'.repeat(32),
    iv: '00'.repeat(12),
    mimeType: 'image/webp',
    size: 1,
    width: 4,
    height: 3,
  };

  it('survives a store and a reload', () => {
    const env = parseEnvelope(serializeEnvelope(mkMediaEnvelope({ ...ref, placeholder: 'AAEC' })));
    expect(env.kind === 'media' && env.media.placeholder).toBe('AAEC');
  });

  it('is absent from an envelope stored before it existed, and a non-string is dropped', () => {
    const old = parseEnvelope(serializeEnvelope(mkMediaEnvelope(ref)));
    expect(old.kind === 'media' && old.media.placeholder).toBeUndefined();
    const raw = JSON.stringify({ kind: 'media', media: { ...ref, placeholder: 42 } });
    const bad = parseEnvelope(raw);
    expect(bad.kind === 'media' && bad.media.placeholder).toBeUndefined();
  });
});
