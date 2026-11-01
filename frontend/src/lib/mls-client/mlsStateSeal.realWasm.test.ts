// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('$lib/wasm/mls_wasm_bg.wasm?url', () => ({ default: 'https://cdn.test/mls_wasm_bg.wasm' }));

import { loadAndInitWasm, resetMlsWasmModuleCacheForTests } from './mlsWasmLoader';
import {
  MlsStateVerdictError,
  openMlsStateBlobV2,
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
    // The construction rejects with `StateLoadRefusal`: the code as a FIELD, never only in prose.
    let rejection: unknown;
    try {
      new bindings.WasmMlsClient('alice', 'web-alice', altered, KEY_B64, true).free();
    } catch (e) {
      rejection = e;
    }
    // The message is the variant's DETAIL, without the code: the typed error leads with the code
    // itself, and a message carrying it too was logged `STATE_ALTERED: STATE_ALTERED: ...`.
    expect(rejection).toEqual({
      code: 'STATE_ALTERED',
      message: expect.not.stringMatching(/STATE_ALTERED/),
    });
  });

  it('a v1 blob refused by the real constructor arrives TYPED through the web load path', async () => {
    // Legacy and v1 blobs never meet WebCrypto: the constructor's refusal is their only verdict,
    // and it is typed at the boundary (`mlsStateLoadErrorOf`), not read out of a message.
    const plain = await openMlsStateBlobV2(sealed, KEY_B64);
    const v1 = bindings.encrypt_mls_state_blob_with_key(plain, KEY_B64) as Uint8Array;
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    for (const [blob, key, user, code] of [
      [v1, other, 'alice', 'STATE_KEY_MISMATCH'],
      [v1, KEY_B64, 'bob', 'IDENTITY_MISMATCH'],
    ] as const) {
      resetMlsWasmModuleCacheForTests();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(wasmResponse());
      const error = await loadAndInitWasm(user, `web-${user}`, blob, key, true).catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(MlsStateVerdictError);
      expect((error as MlsStateVerdictError).code).toBe(code);
      // The code leads the logged text exactly ONCE.
      expect((error as Error).message.split(code)).toHaveLength(2);
      expect((error as Error).message.startsWith(`${code}: `)).toBe(true);
    }
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
