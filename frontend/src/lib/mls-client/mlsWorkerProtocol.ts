/**
 * Message contracts for the three MLS web workers (encrypt, crypto catch-up, key packages).
 *
 * Both ends of a `postMessage` boundary import these types, so a field renamed on one side
 * fails `svelte-check` instead of arriving as `undefined` at runtime. That is not theoretical:
 * the v0.11.0 PIN -> deviceKey rename updated the encrypt worker's reader but not its sender,
 * which kept posting `pin`. Every state save through the worker then handed `undefined` to
 * `encrypt_mls_state_blob_with_key`, and the wasm-bindgen glue died on `undefined.length`.
 * An object literal typed only by the worker's private interface is checked by nobody.
 */

/** Plain CBOR snapshot to seal under the device key, off the main thread. */
export interface MlsEncryptRequest {
  type: 'encrypt';
  payload: {
    plain: ArrayBuffer;
    /** Base64 32-byte device key. Named exactly as the worker destructures it. */
    deviceKeyB64: string;
  };
}

/** Sealed snapshot, wire format `[nonce (12) || ciphertext]`. */
export interface MlsEncryptOk {
  type: 'encrypt:ok';
  payload: { encrypted: ArrayBuffer };
}

/** Worker-side failure, already reduced to a message. */
export interface MlsEncryptErr {
  type: 'encrypt:error';
  error: string;
}

export type MlsEncryptResponse = MlsEncryptOk | MlsEncryptErr;

/** Bootstraps the worker-side MLS client from a plain CBOR snapshot. */
export interface MlsCryptoInitRequest {
  type: 'init';
  userId: string;
  deviceId: string;
  groupId: string;
  state: ArrayBuffer;
}

/** Decrypts one page of ciphertexts against the warm worker client (ratchet advances). */
export interface MlsCryptoDecryptPageRequest {
  type: 'decryptPage';
  messages: ArrayBuffer[];
}

/** Reads back the accumulated plain CBOR state after all pages. */
export interface MlsCryptoFinalizeRequest {
  type: 'finalize';
}

export type MlsCryptoWorkerRequest =
  | MlsCryptoInitRequest
  | MlsCryptoDecryptPageRequest
  | MlsCryptoFinalizeRequest;

/** Per-message outcome inside a decrypted page. */
export type MlsCryptoPageResult =
  | { ok: true; data: ArrayBuffer | null }
  | { ok: false; error: string };

export type MlsCryptoWorkerOk =
  | { type: 'init:ok' }
  | { type: 'decryptPage:ok'; results: MlsCryptoPageResult[] }
  | { type: 'finalize:ok'; state: ArrayBuffer };

export type MlsCryptoWorkerResponse = MlsCryptoWorkerOk | { type: 'error'; error: string };

/**
 * Request payload for key package generation in the dedicated worker.
 * The worker owns a temporary WASM client instance so heavy crypto does not block UI rendering.
 */
export interface MlsKeyPackageRequest {
  type: 'generateKeyPackage';
  payload: {
    userId: string;
    deviceId: string;
    deviceKeyB64: string;
    needed: number;
    state?: ArrayBuffer;
  };
}

/** Generated fallback key package, one-time packages, and the updated sealed state. */
export interface MlsKeyPackageOk {
  type: 'generateKeyPackage:ok';
  payload: {
    fallback: ArrayBuffer;
    poolPackages: ArrayBuffer[];
    state: ArrayBuffer;
  };
}

/** Failed worker response with a human-readable error message. */
export interface MlsKeyPackageErr {
  type: 'generateKeyPackage:error';
  error: string;
}

export type MlsKeyPackageResponse = MlsKeyPackageOk | MlsKeyPackageErr;
