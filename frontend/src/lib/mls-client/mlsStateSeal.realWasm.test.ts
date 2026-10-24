// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('$lib/wasm/mls_wasm_bg.wasm?url', () => ({ default: 'https://cdn.test/mls_wasm_bg.wasm' }));

import { loadAndInitWasm, resetMlsWasmModuleCacheForTests } from './mlsWasmLoader';
import {
  MlsStateVerdictError,
  resetMlsStateSealForTests,
  sealMlsStateBlobV2,
} from './mlsStateSeal';

/**
 * A v2 blob through the REAL WASM, not a mock: the build CI ships (`build-mls-wasm` runs before
 * vitest). The other v2 tests stop at the opener or mock `WasmMlsClient`; this one proves the three
 * things the flip rests on end to end, on the actual `mls-core` compiled to `wasm32`:
 *
 *  1. the web load path (`loadAndInitWasm` -> WebCrypto -> plain CBOR -> `WasmMlsClient`) rebuilds a
 *     state the TypeScript writer sealed, groups included;
 *  2. `mls-core`'s own v2 reader (the sealed blob handed to `WasmMlsClient` with its key - what a
 *     phone does with a restored web state) opens the same bytes;
 *  3. that reader answers `STATE_ALTERED` for a flipped byte - the deterministic verdict, as the
 *     CODE `state_blob_verdict` hands `loadAndInitWasm` when WebCrypto refuses.
 */
const WASM = readFileSync(join(import.meta.dirname, '../wasm/mls_wasm_bg.wasm'));
const KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

function wasmResponse(): Response {
  return new Response(WASM, { status: 200, headers: { 'Content-Type': 'application/wasm' } });
}

describe('a v2 state blob through the real WASM client', () => {
  let bindings: typeof import('$lib/wasm/mls_wasm.js');
  let sealed: Uint8Array;

  beforeAll(async () => {
    bindings = await import('$lib/wasm/mls_wasm.js');
    bindings.initSync({ module: WASM });
    const writer = new bindings.WasmMlsClient('alice', 'web-alice', undefined, undefined, false);
    writer.create_group('group-real-wasm');
    const plain = writer.save_state(undefined) as Uint8Array;
    writer.free();
    resetMlsStateSealForTests();
    sealed = await sealMlsStateBlobV2(plain, KEY_B64);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the web load path rebuilds the state the TypeScript writer sealed', async () => {
    resetMlsWasmModuleCacheForTests();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmResponse());
    const client = await loadAndInitWasm('alice', 'web-alice', sealed, KEY_B64, true);
    expect(Array.from(client.get_groups() as string[])).toContain('group-real-wasm');
    client.free();
  });

  it("mls-core's own v2 reader opens the same sealed bytes (a restored web state on a phone)", () => {
    const client = new bindings.WasmMlsClient('alice', 'web-alice', sealed, KEY_B64, true);
    expect(Array.from(client.get_groups() as string[])).toContain('group-real-wasm');
    client.free();
  });

  it("mls-core's reader calls a flipped byte STATE_ALTERED - the verdict WebCrypto cannot give", () => {
    const altered = sealed.slice();
    altered[altered.length - 1] ^= 1;
    expect(() => new bindings.WasmMlsClient('alice', 'web-alice', altered, KEY_B64, true)).toThrow(
      /STATE_ALTERED/
    );
  });

  it('state_blob_verdict answers a CODE, decided on the Rust variant', () => {
    const altered = sealed.slice();
    altered[altered.length - 1] ^= 1;
    expect(bindings.state_blob_verdict('alice', 'web-alice', sealed, KEY_B64)).toBe('OPENED');
    expect(bindings.state_blob_verdict('alice', 'web-alice', altered, KEY_B64)).toBe(
      'STATE_ALTERED'
    );
    // A blob that opens under this key but names another identity: what stops a SWAPPED blob,
    // since the v2 AAD binds only the 16 header bytes.
    expect(bindings.state_blob_verdict('bob', 'web-bob', sealed, KEY_B64)).toBe(
      'IDENTITY_MISMATCH'
    );
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    expect(bindings.state_blob_verdict('alice', 'web-alice', sealed, other)).toBe(
      'STATE_KEY_MISMATCH'
    );
  });

  it('the web load path turns an altered blob into the TYPED verdict, end to end', async () => {
    resetMlsWasmModuleCacheForTests();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmResponse());
    const altered = sealed.slice();
    altered[altered.length - 1] ^= 1;
    const error = await loadAndInitWasm('alice', 'web-alice', altered, KEY_B64, true).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(MlsStateVerdictError);
    expect((error as MlsStateVerdictError).code).toBe('STATE_ALTERED');
  });
});
