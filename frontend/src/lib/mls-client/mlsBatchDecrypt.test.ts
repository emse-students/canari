import { describe, expect, it, vi } from 'vitest';
import {
  mapNativeBatchDecryptResults,
  mapWasmBatchDecryptResults,
  wasmClientDecryptPage,
} from './mlsBatchDecrypt';

describe('mlsBatchDecrypt', () => {
  it('mapWasmBatchDecryptResults normalises wasm rows', () => {
    expect(
      mapWasmBatchDecryptResults([
        { ok: true, data: new Uint8Array([1]) },
        { ok: true, data: null },
        { ok: false, error: 'gap' },
      ])
    ).toEqual([
      { ok: true, plaintext: new Uint8Array([1]) },
      { ok: true, plaintext: null },
      { ok: false, error: 'gap' },
    ]);
  });

  it('mapNativeBatchDecryptResults normalises Tauri IPC rows (number[] data)', () => {
    expect(
      mapNativeBatchDecryptResults([
        { ok: true, data: [2, 3] },
        { ok: true, data: null },
        { ok: false, error: 'epoch gap' },
      ])
    ).toEqual([
      { ok: true, plaintext: new Uint8Array([2, 3]) },
      { ok: true, plaintext: null },
      { ok: false, error: 'epoch gap' },
    ]);
  });

  it('wasmClientDecryptPage delegates to the wasm client batch API', () => {
    const batch = vi.fn().mockReturnValue([{ ok: true, data: new Uint8Array([42]) }]);
    const client = { process_incoming_messages_batch: batch };
    const out = wasmClientDecryptPage(client, 'g1', [new Uint8Array([9])]);
    expect(batch).toHaveBeenCalledWith('g1', [new Uint8Array([9])]);
    expect(out).toEqual([{ ok: true, plaintext: new Uint8Array([42]) }]);
  });
});
