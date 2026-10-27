// @vitest-environment happy-dom
const wasmInitFn = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const WasmMlsClient = vi.hoisted(() =>
  vi.fn().mockImplementation(function WasmMlsClientMock(this: { tag: string }) {
    this.tag = 'wasm-client';
  })
);

const decryptWithPin = vi.hoisted(() => vi.fn());
/** `mls-core`'s deterministic reader, answering a CODE (`state_blob_verdict` in `mls-wasm`). */
const stateBlobVerdict = vi.hoisted(() => vi.fn());
const encryptWithKey = vi.hoisted(() => vi.fn());

vi.mock('$lib/wasm/mls_wasm.js', () => ({
  default: wasmInitFn,
  init_logger: vi.fn(),
  WasmMlsClient: WasmMlsClient,
  decrypt_with_pin: decryptWithPin,
  encrypt_mls_state_blob_with_key: encryptWithKey,
  state_blob_verdict: stateBlobVerdict,
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
import {
  MlsStateUnreadableNowError,
  MlsStateVerdictError,
  sealMlsStateBlobV2,
} from './mlsStateSeal';
import { MlsStateLoadUntypedError } from './mlsStateLoadError';

function wasmMagicResponse(): Response {
  const buf = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  return new Response(buf, { status: 200, headers: { 'Content-Type': 'application/wasm' } });
}

describe('loadAndInitWasm', () => {
  beforeEach(() => {
    resetMlsWasmModuleCacheForTests();
    wasmInitFn.mockClear();
    WasmMlsClient.mockClear();
    stateBlobVerdict.mockReset();
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
    // A `function`, not an arrow: the loader calls it with `new`, and vitest warns on an arrow there.
    WasmMlsClient.mockImplementationOnce(function () {
      throw new Error('constructor refused the snapshot');
    });

    await expect(loadAndInitWasm('u', 'd', undefined, 'p', true)).rejects.toThrow(
      'constructor refused the snapshot'
    );
    const span = getBootReport().spans.find((s) => s.name === 'wasm-client-construct');
    expect(span?.durationMs).not.toBeNull();
  });

  describe('the v2 dispatch - WebCrypto opens v2, mls-core gets every other shape sealed', () => {
    const KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const plain = new TextEncoder().encode('cbor-mls-snapshot');

    it('hands the WASM the PLAIN snapshot and no key for a v2 blob', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmMagicResponse());
      const blob = await sealMlsStateBlobV2(plain, KEY_B64);
      await loadAndInitWasm('u', 'd', blob, KEY_B64, true);
      const [, , state, key, expected] = WasmMlsClient.mock.calls[0];
      expect(Array.from(state as Uint8Array)).toEqual(Array.from(plain));
      expect(key).toBeUndefined();
      expect(expected).toBe(true);
    });

    it('hands a legacy blob to the WASM sealed, with its key, untouched', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmMagicResponse());
      const legacy = new Uint8Array(64).fill(0xab);
      await loadAndInitWasm('u', 'd', legacy, KEY_B64, true);
      expect(WasmMlsClient).toHaveBeenCalledWith('u', 'd', legacy, KEY_B64, true);
    });

    it('rejects a v2 blob under another key with mls-core code, never constructing a client', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmMagicResponse());
      const blob = await sealMlsStateBlobV2(plain, KEY_B64);
      const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
      await expect(loadAndInitWasm('u', 'd', blob, other, true)).rejects.toThrow(
        /^STATE_KEY_MISMATCH: /
      );
      expect(WasmMlsClient).not.toHaveBeenCalled();
    });

    it('calls a WebCrypto refusal ALTERED only when mls-core answers the code, typed', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmMagicResponse());
      const blob = await sealMlsStateBlobV2(plain, KEY_B64);
      blob[blob.length - 1] ^= 1;
      stateBlobVerdict.mockReturnValueOnce('STATE_ALTERED');
      const error = await loadAndInitWasm('u', 'd', blob, KEY_B64, true).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MlsStateVerdictError);
      expect((error as MlsStateVerdictError).code).toBe('STATE_ALTERED');
      expect((error as MlsStateVerdictError).refusal).toBeInstanceOf(MlsStateUnreadableNowError);
      // The code also leads the message: the word a native load surfaces for the same bytes.
      expect((error as Error).message).toMatch(/^STATE_ALTERED: /);
      // The deterministic reader was asked with the SEALED bytes and the key; no client was built.
      expect(stateBlobVerdict).toHaveBeenCalledWith('u', 'd', blob, KEY_B64);
      expect(WasmMlsClient).not.toHaveBeenCalled();
    });

    it('keeps a refusal mls-core OPENS as unreadable now, installing nothing', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmMagicResponse());
      const blob = await sealMlsStateBlobV2(plain, KEY_B64);
      stateBlobVerdict.mockReturnValueOnce('OPENED');
      const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
      decrypt.mockRejectedValueOnce(new DOMException('engine', 'OperationError'));
      const error = await loadAndInitWasm('u', 'd', blob, KEY_B64, true).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MlsStateUnreadableNowError);
      expect((error as MlsStateUnreadableNowError).deterministicReader).toBe('opened');
      expect(stateBlobVerdict).toHaveBeenCalledTimes(1);
      expect(WasmMlsClient).not.toHaveBeenCalled();
    });

    it('does not ask again for bytes mls-core already opened (a re-read)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmMagicResponse());
      const blob = await sealMlsStateBlobV2(plain, KEY_B64);
      stateBlobVerdict.mockReturnValueOnce('OPENED');
      const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
      decrypt
        .mockRejectedValueOnce(new DOMException('engine', 'OperationError'))
        .mockRejectedValueOnce(new DOMException('engine', 'OperationError'));
      await loadAndInitWasm('u', 'd', blob, KEY_B64, true).catch(() => {});
      const again = await loadAndInitWasm('u', 'd', blob, KEY_B64, true).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(MlsStateUnreadableNowError);
      expect((again as MlsStateUnreadableNowError).deterministicReader).toBe('opened');
      expect(stateBlobVerdict).toHaveBeenCalledTimes(1);
    });

    it.each(['STATE_KEY_MISMATCH', 'IDENTITY_MISMATCH', 'STATE_UNDECRYPTABLE'] as const)(
      'passes the deterministic verdict %s through typed, never unreadable now',
      async (code) => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmMagicResponse());
        const blob = await sealMlsStateBlobV2(plain, KEY_B64);
        stateBlobVerdict.mockReturnValueOnce(code);
        const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
        decrypt.mockRejectedValueOnce(new DOMException('engine', 'OperationError'));
        const error = await loadAndInitWasm('u', 'd', blob, KEY_B64, true).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MlsStateVerdictError);
        expect((error as MlsStateVerdictError).code).toBe(code);
      }
    );

    it('a REJECTION from mls-core is no verdict, whatever its text says', async () => {
      // The classification is the Rust variant's, made before the boundary: a rejection is by
      // contract NOT a verdict, so even a message naming a code must not acquire its recovery.
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmMagicResponse());
      const blob = await sealMlsStateBlobV2(plain, KEY_B64);
      stateBlobVerdict.mockImplementationOnce(() => {
        throw new Error('STATE_ALTERED appears in this text and proves nothing');
      });
      const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
      decrypt.mockRejectedValueOnce(new DOMException('engine', 'OperationError'));
      const error = await loadAndInitWasm('u', 'd', blob, KEY_B64, true).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MlsStateUnreadableNowError);
      expect(error).not.toBeInstanceOf(MlsStateVerdictError);
    });

    it('an answer outside the contract (a bindings mismatch) is unreadable now, never a verdict', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmMagicResponse());
      const blob = await sealMlsStateBlobV2(plain, KEY_B64);
      stateBlobVerdict.mockReturnValueOnce('SOMETHING_NEW');
      const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
      decrypt.mockRejectedValueOnce(new DOMException('engine', 'OperationError'));
      const error = await loadAndInitWasm('u', 'd', blob, KEY_B64, true).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MlsStateUnreadableNowError);
      expect((error as MlsStateUnreadableNowError).deterministicReader).toMatch(
        /^unrecognised answer: SOMETHING_NEW/
      );
    });

    it('keeps a refusal mls-core cannot judge (out of memory) as unreadable now', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmMagicResponse());
      const blob = await sealMlsStateBlobV2(plain, KEY_B64);
      stateBlobVerdict.mockImplementationOnce(() => {
        throw new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded');
      });
      const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
      decrypt.mockRejectedValueOnce(new DOMException('engine', 'OperationError'));
      const error = await loadAndInitWasm('u', 'd', blob, KEY_B64, true).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MlsStateUnreadableNowError);
      expect(String(error)).not.toMatch(/STATE_ALTERED/);
      expect((error as MlsStateUnreadableNowError).deterministicReader).toMatch(
        /^failed: RangeError/
      );
      // A trap may leave the memoised instance unusable: the next load instantiates afresh.
      const fetches = vi.mocked(globalThis.fetch).mock.calls.length;
      await loadAndInitWasm('u', 'd', undefined, undefined, false);
      expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(fetches + 1);
    });
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

  // `mls-core` rejects the construction with `{ code, message }` (`StateLoadRefusal`), and the
  // loader types it AT THE BOUNDARY - for legacy and v1 blobs this is the only verdict path.
  it.each([
    'STATE_ALTERED',
    'STATE_KEY_MISMATCH',
    'STATE_UNDECRYPTABLE',
    'IDENTITY_MISMATCH',
  ] as const)(
    'types a construction refused with the code %s as MlsStateVerdictError',
    async (code) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmMagicResponse());
      WasmMlsClient.mockImplementationOnce(function refused() {
        throw { code, message: `${code}: from mls-core` };
      });
      const error = await loadAndInitWasm('u', 'd', new Uint8Array([1, 2, 3]), 'k', true).catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(MlsStateVerdictError);
      expect((error as MlsStateVerdictError).code).toBe(code);
    }
  );

  it('a construction refused WITHOUT a code is untyped, even when its message names one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmMagicResponse());
    WasmMlsClient.mockImplementationOnce(function refused() {
      throw { code: null, message: 'STATE_ALTERED appears in this text and proves nothing' };
    });
    const error = await loadAndInitWasm('u', 'd', new Uint8Array([1, 2, 3]), 'k', true).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(MlsStateLoadUntypedError);
    expect(error).not.toBeInstanceOf(MlsStateVerdictError);
    // Typed from the contract's own null code, not caught as a malformed rejection.
    expect((error as Error).message).toBe('STATE_ALTERED appears in this text and proves nothing');
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
