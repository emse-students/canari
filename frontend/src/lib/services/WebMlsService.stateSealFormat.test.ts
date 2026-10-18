/**
 * What a web checkpoint actually puts at rest. `MLS_STATE_SEAL_V2_WRITER_ENABLED` is asserted in
 * `mlsStateSeal.test.ts`; this pins that the CHECKPOINT reaches the v2 writer through it - the
 * service's `encryptState`, which `saveState` (every checkpoint) and `changeDeviceKeyImpl` (the PIN
 * change re-seal) both call - and that the bytes it returns open with the web's v2 opener under the
 * same key, and NOT under another (the PIN-change case: the re-sealed blob names the NEW key).
 */
const encryptMlsStateOnMainThread = vi.hoisted(() =>
  vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
);

vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));
vi.mock('../workers/mlsEncrypt.worker?worker', () => ({ default: class {} }));
vi.mock('$lib/mls-client/mlsWasmLoader', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  encryptMlsStateOnMainThread,
}));

import { isMlsStateBlobV2, openMlsStateBlobV2 } from '$lib/mls-client/mlsStateSeal';
import { WebMlsService } from './WebMlsService';

const keyB64 = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));

function encryptState(plain: Uint8Array, deviceKeyB64: string): Promise<Uint8Array> {
  // `useEncryptWorker: false` so the legacy path, were it taken, would answer from the mock above
  // rather than spawn a worker - the assertion then fails on the FORMAT, which is the question.
  const ctx = { useEncryptWorker: false };
  return (
    WebMlsService.prototype.encryptState as (
      this: unknown,
      p: Uint8Array,
      k: string
    ) => Promise<Uint8Array>
  ).call(ctx, plain, deviceKeyB64);
}

describe('WebMlsService.encryptState - the web at-rest format', () => {
  it('seals a checkpoint as framed v2, never through the legacy WASM seal', async () => {
    const plain = new TextEncoder().encode('plain CBOR snapshot');
    const sealed = await encryptState(plain, keyB64(7));

    expect(isMlsStateBlobV2(sealed)).toBe(true);
    expect(encryptMlsStateOnMainThread).not.toHaveBeenCalled();
    expect(await openMlsStateBlobV2(sealed, keyB64(7))).toEqual(plain);
  });

  it('a re-seal under a new device key opens with that key and names the old one a mismatch', async () => {
    const plain = new TextEncoder().encode('state after a PIN change');
    const resealed = await encryptState(plain, keyB64(9));

    expect(await openMlsStateBlobV2(resealed, keyB64(9))).toEqual(plain);
    await expect(openMlsStateBlobV2(resealed, keyB64(7))).rejects.toThrow(/^STATE_KEY_MISMATCH/);
  });
});
