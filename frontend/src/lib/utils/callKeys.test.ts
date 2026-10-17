import { describe, expect, it } from 'vitest';
import {
  CALL_MEDIA_EXPORT_LABEL,
  deriveCallKeys,
  frameAad,
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

const importKey = (raw: Uint8Array, usage: KeyUsage) =>
  crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [usage]);

/** What the worker does to one frame: a random IV, AES-GCM bound to the frame's kind. */
async function seal(key: Uint8Array, kind: 'audio' | 'video', data: Uint8Array) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: frameAad(kind) as BufferSource },
    await importKey(key, 'encrypt'),
    data as BufferSource
  );
  return { iv, ct };
}

async function open(
  key: Uint8Array,
  kind: 'audio' | 'video',
  sealed: { iv: Uint8Array; ct: ArrayBuffer }
) {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: sealed.iv as BufferSource,
        additionalData: frameAad(kind) as BufferSource,
      },
      await importKey(key, 'decrypt'),
      sealed.ct
    )
  );
}

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
});

describe('a frame under the per-direction keys', () => {
  const frame = new Uint8Array([1, 2, 3, 4, 5]);

  it('decrypts at the other end', async () => {
    const caller = await deriveCallKeys(exporter, 'g', 'room-1', 'caller');
    const callee = await deriveCallKeys(exporter, 'g', 'room-1', 'callee');
    const sealed = await seal(caller.send, 'audio', frame);
    expect(await open(callee.receive, 'audio', sealed)).toEqual(frame);
  });

  it('does NOT decrypt when reflected back to its sender', async () => {
    const caller = await deriveCallKeys(exporter, 'g', 'room-1', 'caller');
    const sealed = await seal(caller.send, 'audio', frame);
    await expect(open(caller.receive, 'audio', sealed)).rejects.toThrow();
  });

  it('does NOT decrypt as another media kind', async () => {
    const caller = await deriveCallKeys(exporter, 'g', 'room-1', 'caller');
    const callee = await deriveCallKeys(exporter, 'g', 'room-1', 'callee');
    const sealed = await seal(caller.send, 'audio', frame);
    await expect(open(callee.receive, 'video', sealed)).rejects.toThrow();
  });

  it('does NOT decrypt under another call', async () => {
    const caller = await deriveCallKeys(exporter, 'g', 'room-1', 'caller');
    const other = await deriveCallKeys(exporter, 'g', 'room-2', 'callee');
    const sealed = await seal(caller.send, 'audio', frame);
    await expect(open(other.receive, 'audio', sealed)).rejects.toThrow();
  });
});

describe('keyFingerprint', () => {
  it('is 8 hex characters of the SHA-256, equal for equal keys, and not the key itself', async () => {
    const key = new Uint8Array(32).fill(0xab);
    const fp = await keyFingerprint(key);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(fp).toBe(await keyFingerprint(key.slice()));
    expect(fp).not.toBe('abababab');
  });
});
