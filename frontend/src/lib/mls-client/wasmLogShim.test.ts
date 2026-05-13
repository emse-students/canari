import { describe, it, expect, afterEach } from 'vitest';
import {
  installWasmDuplicateDeliveryLogInterceptor,
  consumeWasmDuplicateDeliveryFlag,
} from './wasmLogShim';

/** WASM init_logger forwards here — not on standard `Window`, so we narrow for tests only. */
type WasmLogWindow = Window & {
  wasm_bindings_log?: (level: string, msg: string) => void;
};

describe('wasmLogShim (resilience: duplicate MLS delivery detection)', () => {
  afterEach(() => {
    delete (window as WasmLogWindow).wasm_bindings_log;
  });

  it('chains prior wasm_bindings_log and sets duplicate flag on SecretReuseError', () => {
    const calls: string[] = [];
    const w = window as WasmLogWindow;
    w.wasm_bindings_log = (level, msg) => {
      calls.push(`${level}:${msg}`);
    };
    installWasmDuplicateDeliveryLogInterceptor();
    w.wasm_bindings_log!('ERROR', 'SecretReuseError in epoch');
    expect(consumeWasmDuplicateDeliveryFlag()).toBe(true);
    expect(consumeWasmDuplicateDeliveryFlag()).toBe(false);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('SecretReuse');
  });

  it('sets duplicate flag on out of bounds message', () => {
    const w = window as WasmLogWindow;
    w.wasm_bindings_log = () => {};
    installWasmDuplicateDeliveryLogInterceptor();
    w.wasm_bindings_log!('ERROR', 'out of bounds access');
    expect(consumeWasmDuplicateDeliveryFlag()).toBe(true);
  });

  it('does not set duplicate flag for unrelated errors', () => {
    const w = window as WasmLogWindow;
    w.wasm_bindings_log = () => {};
    installWasmDuplicateDeliveryLogInterceptor();
    w.wasm_bindings_log!('ERROR', 'WrongEpoch');
    expect(consumeWasmDuplicateDeliveryFlag()).toBe(false);
  });
});
