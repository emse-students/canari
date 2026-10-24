/**
 * What a web checkpoint actually puts at rest. `MLS_STATE_SEAL_V2_WRITER_ENABLED` is asserted in
 * `mlsStateSeal.test.ts` (OFF in this release: the hardened reader ships first); this pins that the
 * CHECKPOINT follows it - the service's `encryptState`, which `saveState` (every checkpoint) and
 * `changeDeviceKeyImpl` (the PIN change re-seal) both call. With the shipped value the checkpoint
 * stays on the legacy WASM seal; with the flag forced on (what the later flip PR ships) the bytes
 * open with the web's v2 opener under the same key, and NOT under another (the PIN-change case: the
 * re-sealed blob names the NEW key).
 */
const writer = vi.hoisted(() => ({ forcedOn: false }));
const encryptMlsStateOnMainThread = vi.hoisted(() =>
  vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
);

vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));
vi.mock('../workers/mlsEncrypt.worker?worker', () => ({ default: class {} }));
vi.mock('$lib/mls-client/mlsStateSeal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/mls-client/mlsStateSeal')>();
  return {
    ...actual,
    get MLS_STATE_SEAL_V2_WRITER_ENABLED() {
      return writer.forcedOn || actual.MLS_STATE_SEAL_V2_WRITER_ENABLED;
    },
  };
});
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
  afterEach(() => {
    writer.forcedOn = false;
    encryptMlsStateOnMainThread.mockClear();
  });

  it('with the shipped writer flag (OFF), a checkpoint stays on the legacy WASM seal', async () => {
    const plain = new TextEncoder().encode('plain CBOR snapshot');
    const sealed = await encryptState(plain, keyB64(7));

    expect(isMlsStateBlobV2(sealed)).toBe(false);
    expect(encryptMlsStateOnMainThread).toHaveBeenCalledTimes(1);
  });

  it('with the writer on, seals a checkpoint as framed v2, never through the legacy WASM seal', async () => {
    writer.forcedOn = true;
    const plain = new TextEncoder().encode('plain CBOR snapshot');
    const sealed = await encryptState(plain, keyB64(7));

    expect(isMlsStateBlobV2(sealed)).toBe(true);
    expect(encryptMlsStateOnMainThread).not.toHaveBeenCalled();
    expect(await openMlsStateBlobV2(sealed, keyB64(7))).toEqual(plain);
  });

  it('with the writer on, a re-seal under a new key opens with it and names the old one a mismatch', async () => {
    writer.forcedOn = true;
    const plain = new TextEncoder().encode('state after a PIN change');
    const resealed = await encryptState(plain, keyB64(9));

    expect(await openMlsStateBlobV2(resealed, keyB64(9))).toEqual(plain);
    await expect(openMlsStateBlobV2(resealed, keyB64(7))).rejects.toThrow(/^STATE_KEY_MISMATCH/);
  });
});
