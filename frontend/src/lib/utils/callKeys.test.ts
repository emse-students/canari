import { describe, expect, it } from 'vitest';
import {
  CALL_MEDIA_EXPORT_LABEL,
  deriveCallKeys,
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

  it('reads both keys with the v2 label, the call id and the sender role as context', async () => {
    const seen: string[] = [];
    const spy: ExportSecret = async (g, label, context, len) => {
      seen.push(`${label}:${new TextDecoder().decode(context)}:${len}`);
      return exporter(g, label, context, len);
    };
    await deriveCallKeys(spy, 'g', 'room-1', 'caller');
    expect(seen.sort()).toEqual([
      `${CALL_MEDIA_EXPORT_LABEL}:room-1|callee:32`,
      `${CALL_MEDIA_EXPORT_LABEL}:room-1|caller:32`,
    ]);
  });

  it('gives another call other keys', async () => {
    const one = await deriveCallKeys(exporter, 'g', 'room-1', 'caller');
    const two = await deriveCallKeys(exporter, 'g', 'room-2', 'caller');
    expect(one.send).not.toEqual(two.send);
    expect(one.receive).not.toEqual(two.receive);
  });
});

// What a frame does under these keys - opened at the other end, refused when reflected or offered
// as the other kind - is tested on the worker itself: `workers/encryption.worker.test.ts`.

describe('keyFingerprint', () => {
  it('is 8 hex characters of the SHA-256, equal for equal keys, and not the key itself', async () => {
    const key = new Uint8Array(32).fill(0xab);
    const fp = await keyFingerprint(key);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(fp).toBe(await keyFingerprint(key.slice()));
    expect(fp).not.toBe('abababab');
  });
});
