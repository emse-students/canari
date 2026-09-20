const wasmInitFn = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const WasmMlsClient = vi.hoisted(() =>
  vi.fn().mockImplementation(function WasmMlsClientMock(this: { tag: string }) {
    this.tag = 'wasm-client';
  })
);

const decryptWithPin = vi.hoisted(() => vi.fn());
const encryptWithKey = vi.hoisted(() => vi.fn());

vi.mock('$lib/wasm/mls_wasm.js', () => ({
  default: wasmInitFn,
  init_logger: vi.fn(),
  WasmMlsClient: WasmMlsClient,
  decrypt_with_pin: decryptWithPin,
  encrypt_mls_state_blob_with_key: encryptWithKey,
}));

vi.mock('$lib/wasm/mls_wasm_bg.wasm?url', () => ({
  default: 'https://cdn.test/mls.wasm',
}));

import {
  loadAndInitWasm,
  migrateLegacyMlsStateBlob,
  resetMlsWasmModuleCacheForTests,
} from './mlsWasmLoader';
import { getBootReport, resetBootBench } from './bootBenchmark';

function wasmMagicResponse(): Response {
  const buf = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  return new Response(buf, { status: 200, headers: { 'Content-Type': 'application/wasm' } });
}

describe('loadAndInitWasm', () => {
  beforeEach(() => {
    resetMlsWasmModuleCacheForTests();
    wasmInitFn.mockClear();
    WasmMlsClient.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { wasm_bindings_log?: unknown }).wasm_bindings_log;
  });

  it('fetches wasm by URL, validates magic, inits module, returns WasmMlsClient', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmMagicResponse());
    const client = await loadAndInitWasm('user-1', 'dev-1', undefined, 'pin', true);
    expect(fetch).toHaveBeenCalledWith(
      'https://cdn.test/mls.wasm',
      expect.objectContaining({ credentials: 'same-origin' })
    );
    expect(wasmInitFn).toHaveBeenCalled();
    expect(WasmMlsClient).toHaveBeenCalled();
    expect(client).toBeDefined();
  });

  it('throws when fetch is not ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    await expect(loadAndInitWasm('u', 'd', undefined, 'p', true)).rejects.toThrow(
      /Chargement WASM impossible/
    );
  });

  it('throws when server returns HTML instead of wasm', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    );
    await expect(loadAndInitWasm('u', 'd', undefined, 'p', true)).rejects.toThrow(/HTML/);
  });

  it('splits the state load into the two spans this layer can honestly separate', async () => {
    // 64% of a cold boot sat inside `mls-load-state` as ONE number on 2026-09-18, which names a
    // cost and no cause. These two say which half; a third span for decryption alone would be a
    // boundary that does not exist, because the constructor does decrypt AND rebuild inside Rust.
    resetBootBench();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmMagicResponse());
    await loadAndInitWasm('user-1', 'dev-1', undefined, 'pin', true);

    const byName = new Map(getBootReport().spans.map((s) => [s.name, s]));
    expect([...byName.keys()]).toEqual(
      expect.arrayContaining(['wasm-module', 'wasm-client-construct'])
    );
    // Closed, not merely opened: an open span reports `null` and would read as a missing platform.
    expect(byName.get('wasm-module')?.durationMs).not.toBeNull();
    expect(byName.get('wasm-client-construct')?.durationMs).not.toBeNull();
  });

  it('closes the constructor span even when the constructor throws', async () => {
    // A step that failed still took the time it took. Losing the span would make a failed boot look
    // faster than a working one, which is the one direction a benchmark must never be wrong in.
    resetBootBench();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmMagicResponse());
    WasmMlsClient.mockImplementationOnce(() => {
      throw new Error('constructor refused the snapshot');
    });

    await expect(loadAndInitWasm('u', 'd', undefined, 'p', true)).rejects.toThrow(
      'constructor refused the snapshot'
    );
    const span = getBootReport().spans.find((s) => s.name === 'wasm-client-construct');
    expect(span?.durationMs).not.toBeNull();
  });

  it('throws when body is not wasm magic', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    );
    await expect(loadAndInitWasm('u', 'd', undefined, 'p', true)).rejects.toThrow(
      /signature incorrecte/
    );
  });
});

/**
 * The one-shot conversion of snapshots written before v0.11.0. Getting the failure case wrong is
 * what matters most: returning anything but `null` for a blob the PIN does not open would send a
 * genuinely rotated state down the migration path instead of offering old-PIN recovery.
 */
describe('migrateLegacyMlsStateBlob', () => {
  const blob = new Uint8Array([9, 9, 9]);

  beforeEach(() => {
    resetMlsWasmModuleCacheForTests();
    decryptWithPin.mockReset();
    encryptWithKey.mockReset();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmMagicResponse());
  });

  afterEach(() => vi.restoreAllMocks());

  it('re-seals a legacy snapshot under the device key', async () => {
    const plain = new Uint8Array([1, 2, 3]);
    const resealed = new Uint8Array([4, 5, 6]);
    decryptWithPin.mockReturnValue(plain);
    encryptWithKey.mockReturnValue(resealed);

    expect(await migrateLegacyMlsStateBlob(blob, '1234', 'key-b64')).toBe(resealed);
    expect(decryptWithPin).toHaveBeenCalledWith('1234', blob);
    // Re-sealed from the decrypted plaintext, never from the legacy envelope.
    expect(encryptWithKey).toHaveBeenCalledWith(plain, 'key-b64');
  });

  it('returns null when the PIN does not open the blob', async () => {
    decryptWithPin.mockImplementation(() => {
      throw new Error('aead::Error');
    });

    expect(await migrateLegacyMlsStateBlob(blob, '1234', 'key-b64')).toBeNull();
    expect(encryptWithKey).not.toHaveBeenCalled();
  });

  it('returns null when re-sealing fails instead of reporting a false success', async () => {
    decryptWithPin.mockReturnValue(new Uint8Array([1]));
    encryptWithKey.mockImplementation(() => {
      throw new Error('invalid device_key_b64');
    });

    expect(await migrateLegacyMlsStateBlob(blob, '1234', 'bad-key')).toBeNull();
  });
});
