/**
 * Resilience: detect harmless duplicate MLS delivery (SecretReuseError / bounds)
 * logged synchronously by WASM before `processIncomingMessage` returns null.
 */

let lastWasmLogWasDuplicate = false;

/** Install once per session; chains any previous `window.wasm_bindings_log`. */
export function installWasmDuplicateDeliveryLogInterceptor(): void {
  if (typeof window === 'undefined') return;
  const origWasmLog = (
    window as unknown as { wasm_bindings_log?: (level: string, msg: string) => void }
  ).wasm_bindings_log;
  (
    window as unknown as { wasm_bindings_log: (level: string, msg: string) => void }
  ).wasm_bindings_log = (level: string, msg: string) => {
    lastWasmLogWasDuplicate = msg.includes('SecretReuseError') || msg.includes('out of bounds');
    origWasmLog?.(level, msg);
  };
}

/** Returns whether the last WASM log indicated duplicate delivery, then clears the flag. */
export function consumeWasmDuplicateDeliveryFlag(): boolean {
  const v = lastWasmLogWasDuplicate;
  lastWasmLogWasDuplicate = false;
  return v;
}
