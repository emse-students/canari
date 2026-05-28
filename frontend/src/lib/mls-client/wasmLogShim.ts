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

/**
 * Remet le flag à zéro avant un appel WASM.
 * À appeler systématiquement juste avant `processIncomingMessage` pour éviter
 * qu'un flag residuel d'un appel précédent soit attribué au mauvais message.
 */
export function resetWasmDuplicateDeliveryFlag(): void {
  lastWasmLogWasDuplicate = false;
}

/** Returns whether the last WASM log indicated duplicate delivery, then clears the flag. */
export function consumeWasmDuplicateDeliveryFlag(): boolean {
  const v = lastWasmLogWasDuplicate;
  lastWasmLogWasDuplicate = false;
  return v;
}
