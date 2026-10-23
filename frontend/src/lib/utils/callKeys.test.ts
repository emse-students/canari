import { describe, expect, it } from 'vitest';
import {
  CALL_MEDIA_EXPORT_LABEL,
  deriveCallKeys,
  directionContext,
  keyFingerprint,
  type ExportSecret,
} from './callKeys';

/**
 * A deterministic stand-in for the MLS exporter: a different secret for every (group, label,
 * context), the same secret for the same inputs - which is all the derivation relies on.
 */
const exporter: ExportSecret = async (groupId, label, context) => {
  const input = new TextEncoder().encode(
    `${groupId}/${label}/${new TextDecoder().decode(context)}`
  );
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
};

describe('deriveCallKeys', () => {
  it('gives the two ends the same two keys, each sending with the one the other receives with', async () => {
    const caller = await deriveCallKeys(exporter, 'g', 'room-1', 'caller');
    const callee = await deriveCallKeys(exporter, 'g', 'room-1', 'callee');

    expect(caller.send).toEqual(callee.receive);
    expect(caller.receive).toEqual(callee.send);
    expect(caller.send).not.toEqual(caller.receive);
  });

  it('exports both keys with the v2 label, `<callId>|<sender role>` as context, 32 bytes each', async () => {
    const seen: string[] = [];
    const spy: ExportSecret = async (g, label, context, len) => {
      seen.push(`${label}:${new TextDecoder().decode(context)}:${len}`);
      return exporter(g, label, context, len);
    };
    await deriveCallKeys(spy, 'g', 'room-1', 'callee');
    expect(CALL_MEDIA_EXPORT_LABEL).toBe('mls-webrtc-media-v2');
    expect(seen.sort()).toEqual([
      'mls-webrtc-media-v2:room-1|callee:32',
      'mls-webrtc-media-v2:room-1|caller:32',
    ]);
  });

  it('encodes the context as the UTF-8 bytes of `<callId>|<role>` (the wire both ends must agree on)', () => {
    expect(Array.from(directionContext('r1', 'caller'))).toEqual(
      Array.from(new TextEncoder().encode('r1|caller'))
    );
  });

  it('gives another call other keys', async () => {
    const one = await deriveCallKeys(exporter, 'g', 'room-1', 'caller');
    const two = await deriveCallKeys(exporter, 'g', 'room-2', 'caller');
    expect(one.send).not.toEqual(two.send);
    expect(one.receive).not.toEqual(two.receive);
  });

  it('copies what the exporter returned: a buffer reused by the exporter cannot change a key', async () => {
    const shared = new Uint8Array(32);
    const reusing: ExportSecret = async (_g, _l, context) => {
      shared.fill(context[context.length - 1]);
      return shared;
    };
    const keys = await deriveCallKeys(reusing, 'g', 'room-1', 'caller');
    expect(keys.send).not.toEqual(keys.receive);
  });

  it('zeroes every buffer the exporter returned once the key is copied out of it', async () => {
    const returned: Uint8Array[] = [];
    const tracking: ExportSecret = async (g, label, context, len) => {
      const out = await exporter(g, label, context, len);
      returned.push(out);
      return out;
    };
    const keys = await deriveCallKeys(tracking, 'g', 'room-1', 'caller');
    expect(returned).toHaveLength(2);
    for (const buffer of returned) expect(buffer.every((b) => b === 0)).toBe(true);
    expect(keys.send.some((b) => b !== 0)).toBe(true);
    expect(keys.receive.some((b) => b !== 0)).toBe(true);
  });
});

describe('keyFingerprint', () => {
  // Bytes 1..32: the key of the worker's known-answer vectors (`encryption.worker.test.ts`).
  const key = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

  it('is the first 4 bytes of the SHA-256 of the key, in hex (a known answer)', async () => {
    // sha256(01..20) computed with node:crypto, outside WebCrypto.
    expect(await keyFingerprint(key)).toBe('ae216c2e');
  });

  it('never prints the key bytes themselves - what the old fp= line did', async () => {
    expect(await keyFingerprint(key)).not.toBe('01020304');
  });

  it('is the same for the same key on two devices, and differs for another key', async () => {
    expect(await keyFingerprint(Uint8Array.from(key))).toBe(await keyFingerprint(key));
    const other = Uint8Array.from(key);
    other[31] ^= 1;
    expect(await keyFingerprint(other)).not.toBe(await keyFingerprint(key));
  });
});
