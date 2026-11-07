import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MLS_STATE_BLOB_HEADER_LEN,
  MLS_STATE_BLOB_MAGIC,
  MLS_STATE_BLOB_V2_IV_LEN,
  MLS_STATE_BLOB_V2_KDF_INFO,
  MLS_STATE_BLOB_V2_KDF_SALT,
  MLS_STATE_SEAL_V2_WRITER_ENABLED,
  MlsStateUnreadableNowError,
  MlsStateVerdictError,
  isMlsStateBlobV2,
  mlsStateKeyFingerprint,
  openMlsStateBlobV2,
  resetMlsStateSealForTests,
  sealMlsStateBlobV2,
} from './mlsStateSeal';

/**
 * The web half of the v2 state blob. The Rust half (`mls-core/tests/state_blob_v2.rs`) opens bytes
 * THIS module wrote; this file pins the same known-answer derivation, so a drift on either side
 * fails on that side, by name, rather than as a state that stops loading.
 */

/** `params::DEVICE_KEY` in `mls-core/tests/cross_version/params.rs`. */
const DEVICE_KEY = new Uint8Array(32).fill(7);
const DEVICE_KEY_B64 = btoa(String.fromCharCode(...DEVICE_KEY));
/** The same two constants `state_blob_v2.rs` asserts. */
const KAT_FINGERPRINT = 'aeb248d2a1f6c577';
const KAT_AES_KEY = 'fe75bd5d3621ef0d97fe8fa2c1bb53ce3c4121fe57ddb4b841a47692012dacb5';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** The AES key derived independently of the module, from the exported constants. */
async function derivedAesKey(): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey('raw', DEVICE_KEY, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: MLS_STATE_BLOB_V2_KDF_SALT,
        info: MLS_STATE_BLOB_V2_KDF_INFO,
      },
      ikm,
      256
    )
  );
}

/** Opens a v2 blob the way `state_blob::open_v2` does - header as AAD - or throws. */
async function openV2(blob: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    (await derivedAesKey()) as Uint8Array<ArrayBuffer>,
    'AES-GCM',
    false,
    ['decrypt']
  );
  const header = blob.slice(0, MLS_STATE_BLOB_HEADER_LEN);
  const iv = blob.slice(MLS_STATE_BLOB_HEADER_LEN, MLS_STATE_BLOB_HEADER_LEN + 12);
  const body = blob.slice(MLS_STATE_BLOB_HEADER_LEN + 12);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: header }, key, body)
  );
}

const plain = new TextEncoder().encode('cbor-mls-snapshot'.repeat(1000));

describe('sealMlsStateBlobV2', () => {
  beforeEach(() => resetMlsStateSealForTests());

  it('derives the same fingerprint and AES key as mls-core (known answer)', async () => {
    expect(hex(await mlsStateKeyFingerprint(DEVICE_KEY))).toBe(KAT_FINGERPRINT);
    expect(hex(await derivedAesKey())).toBe(KAT_AES_KEY);
  });

  it('writes the v2 header: magic, version 2, the device key fingerprint', async () => {
    const blob = await sealMlsStateBlobV2(plain, DEVICE_KEY_B64);
    expect(Array.from(blob.slice(0, 7))).toEqual(Array.from(MLS_STATE_BLOB_MAGIC));
    expect(blob[7]).toBe(2);
    expect(hex(blob.slice(8, 16))).toBe(KAT_FINGERPRINT);
    // header + IV + ciphertext (same length as the plaintext) + 16-byte tag
    expect(blob.length).toBe(16 + MLS_STATE_BLOB_V2_IV_LEN + plain.length + 16);
  });

  it('round-trips, and two seals of the same state never share an IV', async () => {
    const a = await sealMlsStateBlobV2(plain, DEVICE_KEY_B64);
    const b = await sealMlsStateBlobV2(plain, DEVICE_KEY_B64);
    expect(await openV2(a)).toEqual(plain);
    expect(await openV2(b)).toEqual(plain);
    expect(hex(a.slice(16, 28))).not.toBe(hex(b.slice(16, 28)));
  });

  it.each([
    ['the version byte', 7],
    ['a fingerprint byte', 9],
    ['an IV byte', 16],
    ['a ciphertext byte', 40],
    ['the last tag byte', -1],
  ])('refuses a blob with %s flipped (the header is authenticated too)', async (_what, at) => {
    const blob = await sealMlsStateBlobV2(plain, DEVICE_KEY_B64);
    const i = at < 0 ? blob.length + at : at;
    blob[i] ^= 0x01;
    await expect(openV2(blob)).rejects.toThrow();
  });

  it('refuses a truncated blob', async () => {
    const blob = await sealMlsStateBlobV2(plain, DEVICE_KEY_B64);
    await expect(openV2(blob.slice(0, blob.length - 1))).rejects.toThrow();
  });

  it('refuses a device key that is not 32 bytes rather than sealing an unreadable blob', async () => {
    await expect(sealMlsStateBlobV2(plain, btoa('short'))).rejects.toThrow(/32 bytes/);
  });

  it('does not cache a failed key preparation, and derives again for a new device key', async () => {
    await expect(sealMlsStateBlobV2(plain, btoa('short'))).rejects.toThrow();
    // let the rejection handler clear the cache
    await Promise.resolve();
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    const blob = await sealMlsStateBlobV2(plain, other);
    expect(hex(blob.slice(8, 16))).toBe(
      hex(await mlsStateKeyFingerprint(new Uint8Array(32).fill(9)))
    );
    const back = await sealMlsStateBlobV2(plain, DEVICE_KEY_B64);
    expect(hex(back.slice(8, 16))).toBe(KAT_FINGERPRINT);
  });

  it('the committed fixture mls-core opens is this writer output (same header)', () => {
    const fixture = new Uint8Array(
      readFileSync(
        join(import.meta.dirname, '../../../mls-core/tests/fixtures/webcrypto-v2-peer-state.bin')
      )
    );
    expect(hex(fixture.slice(0, 16))).toBe(hex(MLS_STATE_BLOB_MAGIC) + '02' + KAT_FINGERPRINT);
  });

  it('the web opener reads the committed fixture to the frozen plain state (same bytes Rust opens)', async () => {
    const dir = join(import.meta.dirname, '../../../mls-core/tests/fixtures');
    const blob = new Uint8Array(readFileSync(join(dir, 'webcrypto-v2-peer-state.bin')));
    const frozen = new Uint8Array(readFileSync(join(dir, 'v0.14.14-peer-state.bin')));
    expect(isMlsStateBlobV2(blob)).toBe(true);
    expect(await openMlsStateBlobV2(blob, DEVICE_KEY_B64)).toEqual(frozen);
  });

  it('the web opener answers mls-core codes for what the BYTES decide: another key, a stub', async () => {
    const blob = await sealMlsStateBlobV2(plain, DEVICE_KEY_B64);
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    // TYPED AT THE THROW: the classifier reads `code` on the type, never the message.
    const rotated = await openMlsStateBlobV2(blob, other).catch((e: unknown) => e);
    expect(rotated).toBeInstanceOf(MlsStateVerdictError);
    expect((rotated as MlsStateVerdictError).code).toBe('STATE_KEY_MISMATCH');
    expect(String(rotated)).toMatch(/STATE_KEY_MISMATCH: /);
    const stub = await openMlsStateBlobV2(blob.slice(0, 16 + 27), DEVICE_KEY_B64).catch(
      (e: unknown) => e
    );
    expect(stub).toBeInstanceOf(MlsStateVerdictError);
    expect((stub as MlsStateVerdictError).code).toBe('STATE_UNDECRYPTABLE');
    expect((stub as Error).message).toMatch(/^STATE_UNDECRYPTABLE: .*version 2/);
    const notV2 = await openMlsStateBlobV2(new Uint8Array(64), DEVICE_KEY_B64).catch(
      (e: unknown) => e
    );
    expect(notV2).toBeInstanceOf(MlsStateVerdictError);
    expect((notV2 as MlsStateVerdictError).code).toBe('STATE_UNDECRYPTABLE');
  });

  it('an altered body or header is NOT called altered by WebCrypto: unreadable now, typed', async () => {
    // WebCrypto's OperationError names a failed tag AND an engine fault, so the web opener never
    // claims STATE_ALTERED - `loadAndInitWasm` asks mls-core's deterministic reader for that.
    const blob = await sealMlsStateBlobV2(plain, DEVICE_KEY_B64);
    for (const at of [16, 40, blob.length - 1]) {
      const altered = blob.slice();
      altered[at] ^= 1;
      const error = await openMlsStateBlobV2(altered, DEVICE_KEY_B64).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MlsStateUnreadableNowError);
      expect(String(error)).not.toMatch(/STATE_ALTERED/);
      expect((error as MlsStateUnreadableNowError).errorName).toBe('OperationError');
      expect((error as MlsStateUnreadableNowError).keyPrepared).toBe(true);
    }
  });

  it('a WebKit-style OperationError on a ~19 MB state is unreadable now, carrying its evidence', async () => {
    // The reviewer's case: WebKit throws OperationError under memory pressure on a large state.
    // It used to read as STATE_ALTERED, which init answers with an irreversible identity rotation.
    const large = new Uint8Array(19 * 1024 * 1024).fill(0x5a);
    const blob = await sealMlsStateBlobV2(large, DEVICE_KEY_B64);
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    try {
      const fault = new DOMException(
        'The operation failed for an operation-specific reason',
        'OperationError'
      );
      decrypt.mockRejectedValueOnce(fault);
      const error = await openMlsStateBlobV2(blob, DEVICE_KEY_B64).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MlsStateUnreadableNowError);
      const typed = error as MlsStateUnreadableNowError;
      expect(typed.message).toMatch(/^STATE_UNREADABLE_NOW: /);
      expect(String(typed)).not.toMatch(
        /STATE_(ALTERED|KEY_MISMATCH|UNDECRYPTABLE)|IDENTITY_MISMATCH/
      );
      expect(typed.blobBytes).toBe(blob.length);
      expect(typed.errorName).toBe('OperationError');
      expect(typed.keyPrepared).toBe(true);
      expect(typed.cause).toBe(fault);
      // Transient: the next read of the same bytes opens them.
      const reopened = await openMlsStateBlobV2(blob, DEVICE_KEY_B64);
      // Buffer.compare, not toEqual: a deep equality over 19 M elements exhausts the test worker.
      expect(Buffer.compare(Buffer.from(reopened), Buffer.from(large))).toBe(0);
    } finally {
      decrypt.mockRestore();
    }
  });

  it('any other WebCrypto rejection, and a failed key derivation, are unreadable now too', async () => {
    const blob = await sealMlsStateBlobV2(plain, DEVICE_KEY_B64);
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    try {
      for (const other of [
        new DOMException('key not usable for decrypt', 'InvalidAccessError'),
        new TypeError('engine fault'),
      ]) {
        decrypt.mockRejectedValueOnce(other);
        const error = await openMlsStateBlobV2(blob, DEVICE_KEY_B64).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MlsStateUnreadableNowError);
        expect((error as Error).cause).toBe(other);
      }
    } finally {
      decrypt.mockRestore();
    }
    resetMlsStateSealForTests();
    const derive = vi.spyOn(crypto.subtle, 'deriveKey');
    try {
      derive.mockRejectedValueOnce(new DOMException('out of memory', 'OperationError'));
      const error = await openMlsStateBlobV2(blob, DEVICE_KEY_B64).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MlsStateUnreadableNowError);
      expect((error as MlsStateUnreadableNowError).keyPrepared).toBe(false);
    } finally {
      derive.mockRestore();
      await Promise.resolve();
      resetMlsStateSealForTests();
    }
  });

  it('recognises only version 2: legacy, v1 and unknown versions stay with mls-core', async () => {
    const blob = await sealMlsStateBlobV2(plain, DEVICE_KEY_B64);
    for (const version of [1, 3]) {
      const other = blob.slice();
      other[7] = version;
      expect(isMlsStateBlobV2(other)).toBe(false);
    }
    expect(isMlsStateBlobV2(new Uint8Array(64).fill(0xab))).toBe(false);
    expect(isMlsStateBlobV2(blob.slice(0, 15))).toBe(false);
  });

  it('ships the HARDENED reader with the writer OFF, and NEITHER v2 reader may be removed', () => {
    // Reader first, writer later - see MLS_STATE_SEAL_V2_WRITER_ENABLED. The writer turns on in its
    // OWN later pull request, once production's minClientVersion AND the web rollback floor are at
    // or past the tag carrying this reader; that PR moves this assertion, deliberately. Once a
    // browser has written v2, only a v2 reader opens that state, so this also fails if either
    // reader leaves the tree; the Rust reader is pinned by `mls-core/tests/state_blob_v2.rs`.
    expect(MLS_STATE_SEAL_V2_WRITER_ENABLED).toBe(false);
    const loader = readFileSync(join(import.meta.dirname, 'mlsWasmLoader.ts'), 'utf-8');
    expect(loader).toMatch(/isMlsStateBlobV2\(state\)/);
    expect(loader).toMatch(/openMlsStateBlobV2\(state, deviceKeyB64\)/);
    const rust = readFileSync(
      join(import.meta.dirname, '../../../mls-core/src/state_blob.rs'),
      'utf-8'
    );
    expect(rust).toMatch(/pub fn open_v2\(/);
    expect(rust).toMatch(/VERSION_2 =>/);
  });
});
