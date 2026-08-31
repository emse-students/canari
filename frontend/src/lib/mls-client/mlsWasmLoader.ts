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
export type MlsWasmBindings = typeof import('$lib/wasm/mls_wasm.js');

let wasmModulePromise: Promise<MlsWasmBindings> | null = null;

/** Fetches, validates, and initialises the MLS WASM module (idempotent). */
export async function loadMlsWasmModule(): Promise<MlsWasmBindings> {
  if (wasmModulePromise) return wasmModulePromise;

  wasmModulePromise = (async () => {
    const [initWasm, wasmAsset] = await Promise.all([
      import('$lib/wasm/mls_wasm.js'),
      import('$lib/wasm/mls_wasm_bg.wasm?url'),
    ]);

    const wasmUrl = (wasmAsset as { default: string }).default;

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
        throw new Error(`Chargement WASM timeout (15 s) depuis ${wasmUrl} - vérifiez le réseau`, {
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
        // `CannotDecryptOwnMessage` was listed here too, demoting a severity the wasm logger had
        // already demoted one layer down - two string lists that had drifted apart (this one never
        // carried `SecretReuseError`). Neither is needed for it now: `mls-core` classifies our own
        // re-offered frame at the throw and logs it at DEBUG, so no ERROR carries that marker. A
        // demotion that outlives its emitter hides the next thing to produce the same text.
        const isExpectedError =
          level === 'ERROR' && (msg.includes('Wrong Epoch') || msg.includes('wrong epoch'));
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

    return initWasm;
  })();

  return wasmModulePromise;
}

/** Clears the WASM module singleton (test-only). */
export function resetMlsWasmModuleCacheForTests(): void {
  wasmModulePromise = null;
}

/** ChaCha20 encrypt on the current thread with a base64-encoded 32-byte key (fallback when workers are unavailable). */
export async function encryptMlsStateOnMainThread(
  plain: Uint8Array,
  deviceKeyB64: string
): Promise<Uint8Array> {
  const wasm = await loadMlsWasmModule();
  return wasm.encrypt_mls_state_blob_with_key(plain, deviceKeyB64) as Uint8Array;
}

/**
 * Re-seals a pre-v0.11.0 MLS snapshot under the current device key.
 *
 * Installs that predate v0.11.0 hold their snapshot in the Argon2id envelope
 * `[salt (16) || nonce (12) || ciphertext]`, keyed on the raw PIN. v0.11.x reads
 * `[nonce (12) || ciphertext]` keyed on the PBKDF2 device key, and `CanariDBMls_<userId>` is
 * still at schema version 1 - so nothing ever rewrote or dropped those blobs. Without this
 * one-shot conversion every such install reports "your PIN was changed on another device" and
 * offers a recovery that no PIN can satisfy.
 *
 * @param blob         The stored snapshot, as read from IndexedDB.
 * @param pin          The PIN just verified server-side; the legacy key derives from it.
 * @param deviceKeyB64 Current device key the snapshot is re-sealed under.
 * @returns The re-sealed snapshot, or `null` when `blob` is not a legacy envelope this PIN opens
 *          (a current-format blob sealed with another key, or genuinely the wrong PIN).
 */
export async function migrateLegacyMlsStateBlob(
  blob: Uint8Array,
  pin: string,
  deviceKeyB64: string
): Promise<Uint8Array | null> {
  const wasm = await loadMlsWasmModule();
  try {
    const plain = wasm.decrypt_with_pin(pin, blob) as Uint8Array;
    return wasm.encrypt_mls_state_blob_with_key(plain, deviceKeyB64) as Uint8Array;
  } catch {
    // Not a legacy blob (or not this PIN): the caller falls back to the recovery path.
    return null;
  }
}

/**
 * Builds a WASM MLS client for `userId` / `deviceId`, over `state` when there is one.
 *
 * @param stateWasExpected Whether the caller believed this device already held a state. REQUIRED,
 *   and required in this position on purpose: the WASM warns about a device key arriving with no
 *   state beside it, which is a loss on a returning device and the ordinary shape of a first
 *   enrolment. It cannot tell them apart, every caller can, and a parameter the compiler demands is
 *   what stops the next call site from letting it default to whichever is convenient.
 */
export async function loadAndInitWasm(
  userId: string,
  deviceId: string,
  state: Uint8Array | undefined,
  deviceKeyB64: string | undefined,
  stateWasExpected: boolean
): Promise<any> {
  const initWasm = await loadMlsWasmModule();
  return new initWasm.WasmMlsClient(userId, deviceId, state, deviceKeyB64, stateWasExpected);
}
