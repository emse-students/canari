/**
 * WASM loader for WebMlsService.
 *
 * A native build ships it but never calls it: TauriMlsService runs MLS in Rust, and the one
 * importer left in a native graph is `wasmPrefetch.ts`, which `hooks.client.ts` skips under Tauri.
 * The `.wasm` binary reaches those builds anyway, because `backup.ts` imports the bindings for the
 * backup envelope on every platform ([mobile](docs/wiki/frontend/mobile.md)).
 *
 * WASM assets live under `$lib/wasm/` (built output).
 */
import { beginBootSpan, endBootSpan, timeBootSpan } from './bootBenchmark';
import {
  MLS_STATE_VERDICT_CODES,
  MlsStateUnreadableNowError,
  MlsStateVerdictError,
  isMlsStateBlobV2,
  openMlsStateBlobV2,
  type MlsStateVerdictCode,
} from './mlsStateSeal';
import {
  packGraineSignatureChecks,
  type GraineSignatureEngine,
  type GraineSignatureVerdict,
} from '$lib/crypto/graineV2';

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
        throw new Error(`WASM load timed out (15 s) from ${wasmUrl} - check the network`, {
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
        `HTML answered where the WASM binary was expected (${wasmUrl}). Check the static routing / MIME type.`
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
      // THIS SIDE CLASSIFIES NOTHING, AND THAT IS THE POINT. It used to re-match `Wrong Epoch`
      // out of the message text to demote it - a second copy of a list the wasm logger already
      // owned, and the two had drifted (this one never carried `SecretReuseError`, and it carried
      // `CannotDecryptOwnMessage` after that marker had stopped being emitted at ERROR at all).
      // A demotion that outlives its emitter hides the next thing to produce the same text.
      //
      // `WebLogger` in `mls-wasm/src/lib.rs` decides severity where the emitter is KNOWN - it reads
      // `record.target()`, which this boundary cannot see because only the formatted level and
      // message cross it. So there is one list, on the side that can key on who wrote the line, and
      // this function does exactly what its name says: print what Rust decided.
      g.wasm_bindings_log = (level: string, msg: string) => {
        if (level === 'DEBUG') {
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
 * The bytes the deterministic reader already OPENED this page: their verdict is known, so a re-read
 * that WebCrypto refuses again does not load the state a second time for an answer already given.
 * Keyed by the blob itself, which `WebMlsService.loadStateWithKey` hands to every read of one load.
 */
const openedByDeterministicReader = new WeakSet<Uint8Array>();

function isVerdictCode(answer: string): answer is MlsStateVerdictCode {
  return MLS_STATE_VERDICT_CODES.has(answer);
}

/**
 * WebCrypto refused a v2 blob; returns the error that refusal really amounts to, asked of the ONE
 * reader whose answer is a fact about the bytes.
 *
 * `mls-core`'s v2 reader is pure, deterministic software AES-GCM: it has no engine to fault, so a
 * verdict from it is a fact. It crosses the WASM boundary as a CODE (`state_blob_verdict`, which
 * classifies on the Rust variant), and returns here as {@link MlsStateVerdictError} - typed, so no
 * caller reads a recovery out of a message; `STATE_ALTERED` is the only way the alteration is ever
 * proven on the web. If the reader OPENS the same bytes, the WebCrypto refusal was an engine fault,
 * proven; if it REJECTS (not a verdict: out of memory, a trap), nothing is known. Both leave the
 * refusal as {@link MlsStateUnreadableNowError}: unreadable right now, nothing destroyed.
 *
 * What the reader loads is dropped inside `state_blob_verdict`, never installed: it is the witness
 * of a verdict, not a second load path - the primary path (WebCrypto) is what failed, and the
 * accusing line below is what sends the fix there. A reader that failed untyped (a trap, a memory
 * grow refused) may have left the memoised WASM instance unusable, so the next load instantiates
 * afresh.
 */
function verdictOfDeterministicReader(
  initWasm: MlsWasmBindings,
  refusal: MlsStateUnreadableNowError,
  userId: string,
  deviceId: string,
  state: Uint8Array,
  deviceKeyB64: string
): Error {
  if (openedByDeterministicReader.has(state)) {
    refusal.deterministicReader = 'opened';
    console.error(
      `[MLS] state open v2: WebCrypto refused (${refusal.errorName}, ${refusal.blobBytes} B) again bytes mls-core already OPENED - an engine fault, proven; nothing destroyed`
    );
    return refusal;
  }
  let answer: string;
  try {
    answer = initWasm.state_blob_verdict(userId, deviceId, state, deviceKeyB64);
  } catch (e) {
    const failure = String(e).slice(0, 160);
    refusal.deterministicReader = `failed: ${failure}`;
    wasmModulePromise = null;
    console.error(
      `[MLS] state open v2: WebCrypto refused (${refusal.errorName}, ${refusal.blobBytes} B, key ${refusal.keyPrepared ? 'derived' : 'NOT derived'}) and mls-core gave no verdict (${failure}) - unreadable right now, nothing destroyed; the WASM module is instantiated afresh next load`
    );
    return refusal;
  }
  if (answer === 'OPENED') {
    openedByDeterministicReader.add(state);
    refusal.deterministicReader = 'opened';
    console.error(
      `[MLS] state open v2: WebCrypto refused (${refusal.errorName}, ${refusal.blobBytes} B) bytes that mls-core OPENS - an engine fault, proven; nothing destroyed, the state is re-read`
    );
    return refusal;
  }
  if (isVerdictCode(answer)) {
    console.error(
      `[MLS] state open v2: WebCrypto refused (${refusal.errorName}, ${refusal.blobBytes} B) and mls-core's deterministic reader gives the verdict ${answer}`
    );
    return new MlsStateVerdictError(answer, refusal);
  }
  // An answer outside the contract means these bindings and `state_blob_verdict` disagree - a build
  // defect, never a verdict, so it destroys nothing and says so.
  refusal.deterministicReader = `unrecognised answer: ${answer.slice(0, 60)}`;
  console.error(
    `[MLS] state open v2: mls-core's state_blob_verdict answered '${answer.slice(0, 60)}', outside its contract - a bindings mismatch; unreadable right now, nothing destroyed`
  );
  return refusal;
}

/**
 * Builds a WASM MLS client for `userId` / `deviceId`, over `state` when there is one.
 *
 * @param stateWasExpected Whether the caller believed this device already held a state. REQUIRED,
 *   and required in this position on purpose: the WASM warns about a device key arriving with no
 *   state beside it, which is a loss on a returning device and the ordinary shape of a first
 *   enrolment. It cannot tell them apart, every caller can, and a parameter the compiler demands is
 *   what stops the next call site from letting it default to whichever is convenient.
 *
 * TWO BOOT SPANS COME OUT OF HERE, AND THEY SPLIT `mls-load-state` AS FAR AS TYPESCRIPT CAN SPLIT
 * IT. The boot bench read on 2026-09-18 put 64% of a cold start inside `mls-load-state` as one
 * number, which names a cost and no cause ([cold-start](../../../../docs/wiki/frontend/cold-start.md)).
 * These two say which half:
 *
 *  - `wasm-module` IS A WAIT, NOT A DOWNLOAD. `loadMlsWasmModule` is memoised and `hooks.client.ts`
 *    starts it at the earliest client seam there is, so by the time login reaches here the fetch is
 *    usually already in flight. A large value means the prefetch is not arriving in time; a value
 *    near zero means it did its job and says nothing about what the binary cost to fetch.
 *  - `wasm-client-construct` is the Rust constructor: snapshot decryption AND group rebuild.
 *    **THOSE TWO CANNOT BE SEPARATED FROM HERE** - they are one call into WASM - so splitting them
 *    further is a measurement `mls-core` owes, not one this file can take. Reporting three spans
 *    from here would be inventing a boundary that does not exist.
 *
 * Both are WEB-ONLY. A Tauri build never calls this module (`platformMlsService()` in
 * `vite.config.js` ships TauriMlsService there), and its state load crosses the IPC bridge instead, so a native report carries `mls-load-state` and neither of these.
 * An absent span is not a zero one, and the report says `null` rather than 0 for exactly that reason.
 */
export async function loadAndInitWasm(
  userId: string,
  deviceId: string,
  state: Uint8Array | undefined,
  deviceKeyB64: string | undefined,
  stateWasExpected: boolean
): Promise<any> {
  const initWasm = await timeBootSpan('wasm-module', loadMlsWasmModule());
  // A v2 blob is opened by WebCrypto and the WASM is handed plain CBOR (no key): the WASM's
  // software AES opened it ~2.5x slower than it opens ChaCha (mlsStateSeal.ts says why and how
  // much). Every other shape goes in sealed, so `mls-core` still decides legacy, v1 and unknown
  // versions. A rejection carries mls-core's own code and propagates exactly as its throw would.
  let input = state;
  let key = deviceKeyB64;
  if (state && deviceKeyB64 && isMlsStateBlobV2(state)) {
    console.log(`[MLS] state blob is framed v2 (${state.length} B) - opening it with WebCrypto`);
    try {
      input = await timeBootSpan('state-open-v2', openMlsStateBlobV2(state, deviceKeyB64));
    } catch (e) {
      if (!(e instanceof MlsStateUnreadableNowError)) throw e;
      throw verdictOfDeterministicReader(initWasm, e, userId, deviceId, state, deviceKeyB64);
    }
    key = undefined;
  }
  // The constructor is synchronous, so begin/end around it is exact rather than a promise boundary.
  beginBootSpan('wasm-client-construct');
  try {
    return new initWasm.WasmMlsClient(userId, deviceId, input, key, stateWasExpected);
  } finally {
    endBootSpan('wasm-client-construct');
  }
}

/**
 * Graine v2's Ed25519 half on the web: the stateless free functions of the WASM crate, which are
 * `mls-core/src/graine_signature.rs` - the one implementation on every platform (channel-encryption
 * section 21.2). Loading is memoised, so the first call waits for the module and none after it do.
 */
export function wasmGraineSignatureEngine(): GraineSignatureEngine {
  return {
    async newSessionKeyPair() {
      const wasm = await loadMlsWasmModule();
      const pair = wasm.graine_session_keypair() as { secret: Uint8Array; public: Uint8Array };
      return { secret: pair.secret, publicKey: pair.public };
    },
    async signWithSessionKey(secret, message) {
      const wasm = await loadMlsWasmModule();
      return wasm.graine_sign_with_session_key(secret, message) as Uint8Array;
    },
    async verifySignature(publicKey, message, signature) {
      const wasm = await loadMlsWasmModule();
      return wasm.graine_verify_signature(publicKey, message, signature) as GraineSignatureVerdict;
    },
    async verifySignatures(checks) {
      if (checks.length === 0) return [];
      const wasm = await loadMlsWasmModule();
      return wasm.graine_verify_signatures(
        packGraineSignatureChecks(checks)
      ) as GraineSignatureVerdict[];
    },
  };
}
