import {
  mapNativeBatchDecryptResults,
  mapWasmBatchDecryptResults,
  wasmClientDecryptPage,
} from './mlsBatchDecrypt';

describe('mlsBatchDecrypt', () => {
  it('mapWasmBatchDecryptResults normalises wasm rows', () => {
    expect(
      mapWasmBatchDecryptResults([
        { ok: true, data: new Uint8Array([1]), sender: 'bob:dev-b' },
        { ok: true, data: null },
        { ok: false, error: 'gap' },
      ])
    ).toEqual([
      { ok: true, plaintext: new Uint8Array([1]), sender: 'bob:dev-b' },
      { ok: true, plaintext: null },
      { ok: false, error: 'gap' },
    ]);
  });

  it('mapNativeBatchDecryptResults normalises Tauri IPC rows (number[] data)', () => {
    expect(
      mapNativeBatchDecryptResults([
        { ok: true, data: [2, 3], sender: 'bob:dev-b' },
        { ok: true, data: null },
        { ok: false, error: 'epoch gap' },
      ])
    ).toEqual([
      { ok: true, plaintext: new Uint8Array([2, 3]), sender: 'bob:dev-b' },
      { ok: true, plaintext: null },
      { ok: false, error: 'epoch gap' },
    ]);
  });

  // Channel-encryption section 21: native omits `sender` when the credential was unreadable (serde
  // skips a `None`) and WASM sends `null`. Both are a plaintext whose sender cannot be checked, and
  // neither may read as "this path carries no sender", which is what `undefined` means downstream.
  it('maps an absent sender beside a plaintext to null, on both engines', () => {
    expect(mapNativeBatchDecryptResults([{ ok: true, data: [7] }])).toEqual([
      { ok: true, plaintext: new Uint8Array([7]), sender: null },
    ]);
    expect(
      mapWasmBatchDecryptResults([{ ok: true, data: new Uint8Array([7]), sender: null }])
    ).toEqual([{ ok: true, plaintext: new Uint8Array([7]), sender: null }]);
  });

  it('wasmClientDecryptPage delegates to the wasm client batch API', () => {
    const batch = vi
      .fn()
      .mockReturnValue([{ ok: true, data: new Uint8Array([42]), sender: 'bob:dev-b' }]);
    const client = { process_incoming_messages_batch: batch };
    const out = wasmClientDecryptPage(client, 'g1', [new Uint8Array([9])]);
    expect(batch).toHaveBeenCalledWith('g1', [new Uint8Array([9])]);
    expect(out).toEqual([{ ok: true, plaintext: new Uint8Array([42]), sender: 'bob:dev-b' }]);
  });
});
