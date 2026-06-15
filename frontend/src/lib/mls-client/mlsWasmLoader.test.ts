import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const wasmInitFn = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const WasmMlsClient = vi.hoisted(() =>
  vi.fn().mockImplementation(function WasmMlsClientMock(this: { tag: string }) {
    this.tag = 'wasm-client';
  })
);

vi.mock('$lib/wasm/mls_wasm.js', () => ({
  default: wasmInitFn,
  init_logger: vi.fn(),
  WasmMlsClient: WasmMlsClient,
}));

vi.mock('$lib/wasm/mls_wasm_bg.wasm?url', () => ({
  default: 'https://cdn.test/mls.wasm',
}));

import { loadAndInitWasm, resetMlsWasmModuleCacheForTests } from './mlsWasmLoader';

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
    const client = await loadAndInitWasm('user-1', 'dev-1', undefined, 'pin');
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
    await expect(loadAndInitWasm('u', 'd', undefined, 'p')).rejects.toThrow(
      /Chargement WASM impossible/
    );
  });

  it('throws when server returns HTML instead of wasm', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    );
    await expect(loadAndInitWasm('u', 'd', undefined, 'p')).rejects.toThrow(/HTML/);
  });

  it('throws when body is not wasm magic', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    );
    await expect(loadAndInitWasm('u', 'd', undefined, 'p')).rejects.toThrow(/signature incorrecte/);
  });
});
