/**
 * WASM loader for WebMlsService.
 *
 * This module is the ONLY place in the codebase that contains static-string
 * dynamic imports of the compiled WASM assets. By isolating them here, the
 * `mls-wasm-stub` Vite plugin can replace this entire module with a no-op
 * stub when TAURI_TARGET is set - so Vite never resolves or bundles the WASM
 * files in Tauri (AppImage / Android) builds.
 *
 * WASM assets live under `$lib/wasm/` (built output).
 */
export async function loadAndInitWasm(
  userId: string,
  deviceId: string,
  state: Uint8Array | undefined,
  pin: string
): Promise<any> {
  const [initWasm, wasmAsset] = await Promise.all([
    import('$lib/wasm/mls_wasm.js'),
    import('$lib/wasm/mls_wasm_bg.wasm?url'),
  ]);

  const wasmUrl = (wasmAsset as { default: string }).default;

  // Abort the fetch if it takes more than 15 seconds — prevents the app from hanging
  // indefinitely when the WASM file is unavailable or the network is degraded.
  const fetchAbort = new AbortController();
  const fetchTimeout = setTimeout(() => fetchAbort.abort(), 15_000);
  let wasmResponse: Response;
  try {
    wasmResponse = await fetch(wasmUrl, {
      credentials: 'same-origin',
      signal: fetchAbort.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(`Chargement WASM timeout (15 s) depuis ${wasmUrl} — vérifiez le réseau`, {
        cause: e,
      });
    }
    throw e;
  } finally {
    clearTimeout(fetchTimeout);
  }

  if (!wasmResponse.ok) {
    throw new Error(
      `Chargement WASM impossible (${wasmResponse.status} ${wasmResponse.statusText}) depuis ${wasmUrl}`
    );
  }

  const contentType = wasmResponse.headers.get('Content-Type')?.toLowerCase() ?? '';
  if (contentType.includes('text/html')) {
    throw new Error(
      `Réponse HTML reçue à la place du binaire WASM (${wasmUrl}). Vérifiez le routage statique / MIME.`
    );
  }

  const magic = new Uint8Array((await wasmResponse.clone().arrayBuffer()).slice(0, 4));
  const isWasmMagic =
    magic[0] === 0x00 && magic[1] === 0x61 && magic[2] === 0x73 && magic[3] === 0x6d;
  if (!isWasmMagic) {
    throw new Error(`Binaire WASM invalide (${wasmUrl}) : signature incorrecte.`);
  }

  await initWasm.default({ module_or_path: wasmResponse });

  const g = globalThis as typeof globalThis & {
    wasm_bindings_log?: (level: string, msg: string) => void;
  };
  if (typeof g.wasm_bindings_log !== 'function') {
    g.wasm_bindings_log = (level: string, msg: string) => {
      const isExpectedError =
        level === 'ERROR' &&
        (msg.includes('Wrong Epoch') ||
          msg.includes('CannotDecryptOwnMessage') ||
          msg.includes('wrong epoch'));
      if (isExpectedError) {
        console.debug(`[RUST::${level}] ${msg}`);
      } else if (level === 'DEBUG') {
        console.debug(`[RUST::${level}] ${msg}`);
      } else {
        console.log(`[RUST::${level}] ${msg}`);
      }
    };
  }

  if (initWasm.init_logger) {
    initWasm.init_logger();
  }

  return new initWasm.WasmMlsClient(userId, deviceId, state, pin);
}
