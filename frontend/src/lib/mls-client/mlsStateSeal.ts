/**
 * The WEB half of the framed v2 MLS state blob: AES-256-GCM through WebCrypto - the writer, and the
 * web's opener.
 *
 * WHY IT EXISTS. On a 7.7 MB state, desktop Chrome spent 141 ms of a 175 ms checkpoint in the WASM
 * ChaCha20-Poly1305 seal - `chacha20` has no SIMD backend on `wasm32` and runs at ~55 MB/s - while
 * the browser's own AES-GCM runs on hardware AES. Measured in
 * `docs/wiki/frontend/performance-audit-2026-10-12.md` (finding 3) and, for this module, by
 * `tools/perf-bench/checkpoint.html`.
 *
 * THE FORMAT IS DEFINED IN RUST: `mls-core/src/state_blob.rs` (module docs, "Version 2") reads it
 * on every target, because a `.canari` backup carries a web-sealed state to a phone. Its constants
 * are mirrored here, pinned on both sides by the same known-answer bytes AND the same frozen blob
 * (`mlsStateSeal.test.ts` here, `tests/state_blob_v2.rs` there):
 *
 *   `[ "CANARIS" | 0x02 | fingerprint(device key) (8) ] [ iv (12) | AES-256-GCM ciphertext | tag (16) ]`
 *
 * with the 16 header bytes as the AAD and the AES key = HKDF-SHA256(device key, salt, info).
 *
 * WHY THE WEB ALSO OPENS V2 HERE, rather than leaving it to the WASM reader: RustCrypto's AES has no
 * hardware path on `wasm32`, and the bench measured the WASM opening a 7.7 MB v2 blob in 610-618 ms
 * against 233-240 ms for the ChaCha one - the checkpoint saving would have been paid back, and more, on
 * every cold start. So on the web, v2 is opened by WebCrypto and the WASM is handed the plain CBOR;
 * every OTHER shape (legacy, v1, an unknown version) still goes to `mls-core` sealed, which stays
 * the one place those are decided. The two v2 readers cannot drift silently: both open the same
 * committed fixture, and both answer the same typed codes (`STATE_KEY_MISMATCH`, `STATE_ALTERED`,
 * `STATE_UNDECRYPTABLE`) that `classifyStateLoadFailure` reads.
 *
 * DEPENDENCY-FREE ON PURPOSE: the perf bench serves this exact file to a bare page, so it can
 * import nothing behind a `$lib` alias. The "never on Tauri" guard therefore lives at the writer's
 * one caller, `sealWebMlsState` (`mlsEncryptWorkerSession.ts`); the opener's one caller is
 * `loadAndInitWasm`, a module no Tauri build ships.
 */

/**
 * WHETHER THE WEB CHECKPOINT WRITES V2. ON SINCE 2026-10-18, the reader having shipped first.
 *
 * Read-first, write-later - the same sequence `state_blob`'s v1 header follows, for the same reason:
 * a build that predates the reader fails a v2 blob (loudly, into `STATE_UNDECRYPTABLE`, destroying
 * nothing - but the user is then asked for a PIN and holds a state no PIN opens in that build).
 * Three paths hand a v2 blob to such a build: a web deploy ROLLED BACK; a tab still running the
 * previous bundle that re-reads IndexedDB (an unlock after a deploy); and a `.canari` backup
 * exported on the web and restored on a phone whose store build predates the reader. Both
 * conditions now hold: the reader shipped in the stable `v1.2.7` (#1793), which served the web, and
 * production's `minClientVersion` is `1.2.7`, which closes the backup path.
 *
 * THIS IS A ONE-WAY DOOR FOR THE DATA, NOT FOR THE CODE. Turning it back to `false` only stops new
 * v2 writes; every blob already written stays v2 until its next checkpoint, so the READERS
 * (`openMlsStateBlobV2` here, `state_blob::open_v2` in `mls-core`) are permanent, and a web rollback
 * must never go below `v1.2.7` (`docs/wiki/protocols/mls-protocol.md`, "v2 - the browser seals with
 * WebCrypto").
 */
export const MLS_STATE_SEAL_V2_WRITER_ENABLED = true;

/** "CANARIS", shared with every framed version - `state_blob::MAGIC`. */
export const MLS_STATE_BLOB_MAGIC = new Uint8Array([0x43, 0x41, 0x4e, 0x41, 0x52, 0x49, 0x53]);

/** `state_blob::VERSION_2`. */
export const MLS_STATE_BLOB_VERSION_2 = 2;

/** `state_blob::HEADER_LEN`: magic (7) + version (1) + fingerprint (8). */
export const MLS_STATE_BLOB_HEADER_LEN = 16;

/** `state_blob::V2_IV_LEN`. */
export const MLS_STATE_BLOB_V2_IV_LEN = 12;

const encoder = new TextEncoder();

/** `state_blob::FINGERPRINT_DOMAIN`. */
const FINGERPRINT_DOMAIN = encoder.encode('canari/mls-state-blob/key-fingerprint/v1');

/** `state_blob::V2_KDF_SALT`. */
export const MLS_STATE_BLOB_V2_KDF_SALT = encoder.encode('canari/mls-state-blob/v2/salt');

/** `state_blob::V2_KDF_INFO`. */
export const MLS_STATE_BLOB_V2_KDF_INFO = encoder.encode('canari/mls-state-blob/v2/aes-256-gcm');

/** What one device key costs to prepare, kept so a checkpoint pays for the seal and nothing else. */
interface PreparedKey {
  /** The 16 header bytes - identical for every blob sealed under this device key. */
  header: Uint8Array<ArrayBuffer>;
  /** Non-extractable: the derived AES key never exists as bytes on this side. */
  aesKey: CryptoKey;
}

/**
 * ONE ENTRY, because a session seals under one device key at a time and a PIN change replaces it.
 * A promise rather than a value so two checkpoints racing the first derivation share it.
 */
let prepared: Promise<PreparedKey> | null = null;
let preparedFor: string | null = null;

function decodeDeviceKey(deviceKeyB64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(deviceKeyB64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length !== 32) {
    // The same refusal `decode_base64_to_32_bytes` makes in Rust, so a malformed key fails the
    // write here rather than sealing a blob no reader will ever accept.
    throw new Error(`deviceKeyB64 must decode to 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * The first 8 bytes of SHA-256(domain || device key) - `state_blob::key_fingerprint`, byte for
 * byte. It is what lets a reader say "sealed under another key" as a FACT, before any cipher runs.
 */
export async function mlsStateKeyFingerprint(deviceKey: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(FINGERPRINT_DOMAIN.length + deviceKey.length);
  input.set(FINGERPRINT_DOMAIN, 0);
  input.set(deviceKey, FINGERPRINT_DOMAIN.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return digest.slice(0, 8);
}

async function prepareKey(deviceKeyB64: string): Promise<PreparedKey> {
  console.log('[MLS] state seal v2: deriving the AES-GCM key for this device key (once per key)');
  const raw = decodeDeviceKey(deviceKeyB64);
  const header = new Uint8Array(MLS_STATE_BLOB_HEADER_LEN);
  header.set(MLS_STATE_BLOB_MAGIC, 0);
  header[MLS_STATE_BLOB_MAGIC.length] = MLS_STATE_BLOB_VERSION_2;
  header.set(await mlsStateKeyFingerprint(raw), MLS_STATE_BLOB_MAGIC.length + 1);
  const ikm = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  raw.fill(0);
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: MLS_STATE_BLOB_V2_KDF_SALT,
      info: MLS_STATE_BLOB_V2_KDF_INFO,
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return { header, aesKey };
}

function preparedKeyFor(deviceKeyB64: string): Promise<PreparedKey> {
  if (!prepared || preparedFor !== deviceKeyB64) {
    preparedFor = deviceKeyB64;
    const attempt = prepareKey(deviceKeyB64);
    prepared = attempt;
    // A failed derivation must not be cached for the rest of the session: the next checkpoint
    // retries it. LOGGED, because the rejection itself is reported by the awaiting caller and this
    // branch is the one place that knows the cache was dropped.
    attempt.catch((e) => {
      if (prepared === attempt) {
        console.warn(`[MLS] state seal v2: key preparation failed, not cached: ${String(e)}`);
        prepared = null;
        preparedFor = null;
      }
    });
  }
  return prepared;
}

/**
 * Seals a plain CBOR MLS snapshot as a framed v2 blob under `deviceKeyB64`.
 *
 * Runs on the calling thread and needs no worker: WebCrypto copies `plain` when called and does
 * the cipher work off the JavaScript thread in every engine this ships to, which is what the
 * encrypt worker existed to buy for the WASM seal. The IV is 96 random bits per call; at the
 * ~2^32-seal bound for random GCM IVs under one key, a device checkpointing every second would
 * need 136 years.
 *
 * NEVER CALLED ON TAURI: the guard is at the caller (see the file header). A native build would
 * read what this writes - the reader is in `mls-core` - but no native path writes it.
 */
export async function sealMlsStateBlobV2(
  plain: Uint8Array,
  deviceKeyB64: string
): Promise<Uint8Array> {
  const { header, aesKey } = await preparedKeyFor(deviceKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(MLS_STATE_BLOB_V2_IV_LEN));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: header },
      aesKey,
      plain as Uint8Array<ArrayBuffer>
    )
  );
  const out = new Uint8Array(header.length + iv.length + sealed.length);
  out.set(header, 0);
  out.set(iv, header.length);
  out.set(sealed, header.length + iv.length);
  return out;
}

/** True when `blob` announces framing version 2 - the exact test `state_blob::parse` makes. */
export function isMlsStateBlobV2(blob: Uint8Array): boolean {
  if (blob.length < MLS_STATE_BLOB_HEADER_LEN) return false;
  for (let i = 0; i < MLS_STATE_BLOB_MAGIC.length; i++) {
    if (blob[i] !== MLS_STATE_BLOB_MAGIC[i]) return false;
  }
  return blob[MLS_STATE_BLOB_MAGIC.length] === MLS_STATE_BLOB_VERSION_2;
}

/**
 * WebCrypto refused to open a v2 blob, and that refusal PROVES NOTHING ABOUT THE BYTES.
 *
 * WebCrypto answers a failed AES-GCM tag with `OperationError` - and WebKit answers an engine fault
 * (memory pressure on a ~19 MB state, among others) with the same name. So no rejection from
 * `crypto.subtle` is evidence of alteration, and this type is NOT `STATE_ALTERED`: it is
 * "unreadable right now, nothing destroyed". The verdict on the bytes is asked of `mls-core`'s
 * deterministic reader by `loadAndInitWasm` (`mlsWasmLoader.ts`), which turns it into `STATE_ALTERED`
 * only when that reader fails the same tag; otherwise this travels on, the caller re-reads a
 * bounded number of times and then stops with the blob untouched - never a rotation.
 *
 * It carries the evidence separating the causes it cannot itself distinguish: the blob's size, the
 * engine's error name, whether the key derivation (the unwrap) had succeeded, and - once
 * `loadAndInitWasm` asked - what the deterministic reader answered.
 */
export class MlsStateUnreadableNowError extends Error {
  /** What `mls-core`'s reader answered for the same bytes, once asked (`loadAndInitWasm`). */
  deterministicReader: string | null = null;

  constructor(
    readonly blobBytes: number,
    readonly errorName: string,
    readonly keyPrepared: boolean,
    cause: unknown
  ) {
    super(
      `STATE_UNREADABLE_NOW: WebCrypto refused the v2 state blob (${blobBytes} B, ${errorName}, key ${keyPrepared ? 'derived' : 'NOT derived'}) - not proof of alteration, nothing destroyed: ${String(cause)}`,
      { cause }
    );
    this.name = 'MlsStateUnreadableNowError';
  }
}

/** The engine's own name for a rejection, tested by NAME: a DOMException is realm-bound. */
function errorNameOf(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

/**
 * Opens a v2 blob on the web, returning the plain CBOR snapshot for the WASM to load.
 *
 * Rejects with the codes `classifyStateLoadFailure` reads: `STATE_KEY_MISMATCH` when the header
 * names another device key (checked BEFORE the cipher, so a rotation is a fact, not a guess) and
 * `STATE_UNDECRYPTABLE` for a stub too short to carry a body - both decided from the bytes alone,
 * the same as `mls-core`. A rejection from WebCrypto itself (key derivation or decrypt) is
 * {@link MlsStateUnreadableNowError}, NEVER `STATE_ALTERED`: see that type for why.
 */
export async function openMlsStateBlobV2(
  blob: Uint8Array,
  deviceKeyB64: string
): Promise<Uint8Array> {
  if (!isMlsStateBlobV2(blob)) {
    throw new Error('STATE_UNDECRYPTABLE: not a framed v2 state blob');
  }
  // A stored blob is never backed by a SharedArrayBuffer; the cast says so to WebCrypto's types.
  const bytes = blob as Uint8Array<ArrayBuffer>;
  const body = bytes.subarray(MLS_STATE_BLOB_HEADER_LEN);
  if (body.length < MLS_STATE_BLOB_V2_IV_LEN + 16) {
    throw new Error(
      `STATE_UNDECRYPTABLE: framed state blob (version 2) carries ${body.length} byte(s) after its header, too short to hold its 28-byte minimum`
    );
  }
  let keyMaterial: PreparedKey;
  try {
    keyMaterial = await preparedKeyFor(deviceKeyB64);
  } catch (e) {
    console.error(
      `[MLS] state open v2: the AES key could not be derived (${errorNameOf(e)}, blob ${blob.length} B) - unreadable right now, nothing destroyed`
    );
    throw new MlsStateUnreadableNowError(blob.length, errorNameOf(e), false, e);
  }
  const { header, aesKey } = keyMaterial;
  for (let i = MLS_STATE_BLOB_MAGIC.length + 1; i < MLS_STATE_BLOB_HEADER_LEN; i++) {
    if (blob[i] !== header[i]) {
      throw new Error(
        "STATE_KEY_MISMATCH: the state's header names a different device key, so the PIN was rotated on another device and the OLD one opens this state"
      );
    }
  }
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: body.subarray(0, MLS_STATE_BLOB_V2_IV_LEN),
          additionalData: bytes.subarray(0, MLS_STATE_BLOB_HEADER_LEN),
        },
        aesKey,
        body.subarray(MLS_STATE_BLOB_V2_IV_LEN)
      )
    );
  } catch (e) {
    // `OperationError` IS a failed tag - AND a WebKit engine fault, under the same name. It was read
    // as `STATE_ALTERED` here, which `init` answers with an IRREVERSIBLE identity rotation even under
    // `noFreshStart`: an out-of-memory decrypt would have destroyed a healthy state. No WebCrypto
    // rejection is a verdict on the bytes; `loadAndInitWasm` asks the deterministic reader for one.
    console.error(
      `[MLS] state open v2: WebCrypto refused the blob (${errorNameOf(e)}, blob ${blob.length} B, key derived) - not proof of alteration, nothing destroyed`
    );
    throw new MlsStateUnreadableNowError(blob.length, errorNameOf(e), true, e);
  }
}

/** Drops the prepared key, so a test starts from a cold derivation. */
export function resetMlsStateSealForTests(): void {
  prepared = null;
  preparedFor = null;
}
