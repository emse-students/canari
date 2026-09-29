import type { StoredGraineSession } from '$lib/db/types';
import { canari } from '$lib/proto/canari';
import { toBase64 } from '$lib/utils/hex';
import { seedFromWire, storedV2Of, toWireSeed } from './wireSeed';

/**
 * The one reader and writer of a wire seed (channel-encryption section 21). What matters is what a
 * RELAY does: a v2 session read off the wire and written back must be byte-identical in every field
 * the endorsement signs, or every repaired session becomes one nobody can verify.
 */

const held: StoredGraineSession = {
  workspaceId: 'ws-1',
  channelId: 'chan-1',
  sessionId: 'sess-1',
  senderId: 'alice',
  seedB64: toBase64(new Uint8Array(32).fill(1)),
  firstIndex: 3,
  createdAt: 1_790_000_000_000,
  v2: {
    minterDeviceId: 'dev-a',
    signingPublicKeyB64: toBase64(new Uint8Array(32).fill(2)),
    endorsementB64: toBase64(new Uint8Array(64).fill(3)),
    signingSecretKeyB64: toBase64(new Uint8Array(32).fill(4)),
  },
};

/** Through the real proto encoder, as a relay's answer travels. */
function overTheWire(seed: canari.GraineMsg.$Properties): canari.GraineMsg.$Properties {
  return canari.GraineMsg.decode(canari.GraineMsg.encode(seed).finish());
}

describe('wireSeed', () => {
  it('relays a v2 session unchanged through the proto, and never its secret', () => {
    const wire = overTheWire(toWireSeed(held));
    const incoming = seedFromWire(wire);

    expect(incoming.v2?.minterUserId).toBe('alice');
    expect(storedV2Of(incoming)).toEqual({
      minterDeviceId: 'dev-a',
      signingPublicKeyB64: held.v2?.signingPublicKeyB64,
      endorsementB64: held.v2?.endorsementB64,
    });
    expect(incoming.firstIndex).toBe(3);
    expect(canari.GraineMsg.encode(wire).finish()).not.toContain(4);
  });

  it('reads a v1 seed as v1, with no v2 half at all', () => {
    const v1 = seedFromWire(overTheWire(toWireSeed({ ...held, v2: undefined })));
    expect(v1.v2).toBeUndefined();
    expect(storedV2Of(v1)).toBeUndefined();
  });

  it('keeps a version-2 seed with missing fields as v2, so the reader refuses it', () => {
    const partial = seedFromWire(
      overTheWire({ channelId: 'c', sessionId: 's', seed: new Uint8Array(32), version: 2 })
    );
    expect(partial.v2?.minterUserId).toBe('');
    expect(partial.v2?.minterDeviceId).toBe('');
    expect(partial.v2?.signingPublicKey).toHaveLength(0);
    expect(partial.v2?.endorsement).toHaveLength(0);
  });
});
