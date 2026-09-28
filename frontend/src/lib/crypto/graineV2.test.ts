import { describe, expect, it } from 'vitest';
import { GraineInputError } from '$lib/crypto/graine';
import {
  encodeGraineEndorsementV2,
  encodeGraineHeaderV2,
  graineSeedCommitment,
  GraineSignatureError,
  openWithGraineV2,
  sealWithGraineV2,
  verifyGraineEndorsementV2,
  type GraineEndorsementV2,
  type GraineMessageHeaderV2,
  type GraineSignatureEngine,
} from '$lib/crypto/graineV2';
import { fromBase64, toBase64 } from '$lib/utils/hex';

/**
 * WP-G2-2 (channel-encryption §21). The engine here is WebCrypto's Ed25519 - available in the test
 * runtime, not in every WebView, which is why production uses the Rust one. Ed25519 is
 * deterministic, so the two must produce the SAME bytes: the vectors below were computed from the
 * specification with WebCrypto alone and are asserted again, independently, by `mobile/graine.rs`
 * (aes-gcm, sha2, ed25519-dalek) - the pair is the contract a push decrypted natively rests on.
 */

const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

const webCryptoEngine: GraineSignatureEngine = {
  async signWithSessionKey(secret, message) {
    const key = await crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array([...PKCS8_ED25519_PREFIX, ...secret]),
      { name: 'Ed25519' },
      false,
      ['sign']
    );
    return new Uint8Array(await crypto.subtle.sign('Ed25519', key, message as BufferSource));
  },
  async verifySignature(publicKey, message, signature) {
    if (publicKey.length !== 32) return 'malformed-public-key';
    if (signature.length !== 64) return 'malformed-signature';
    const key = await crypto.subtle.importKey(
      'raw',
      publicKey as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const ok = await crypto.subtle.verify(
      'Ed25519',
      key,
      signature as BufferSource,
      message as BufferSource
    );
    return ok ? 'valid' : 'invalid';
  },
};

const range = (start: number, length: number) => Uint8Array.from({ length }, (_, i) => start + i);
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (text: string) => Uint8Array.from(text.match(/../g)!, (b) => parseInt(b, 16));

const SEED = range(0, 32);
const SESSION_SECRET = range(0, 32);
const HEADER: GraineMessageHeaderV2 = {
  channelId: 'chan-1',
  sessionId: 'test-session',
  minterUserId: 'alice',
  index: 7,
};

/** The shared vectors. The same values are asserted in `frontend/src-tauri/src/mobile/graine.rs`. */
const V = {
  header:
    '0000001063616e6172692d677261696e652d7632000000066368616e2d310000000c746573742d73657373696f6e00000005616c69636500000007',
  sealed: {
    ciphertext: 'CCdfoCGS9kY27uJzr/2OC1Fn92Pi1uNh6VFb5tu6Pg==',
    nonce: 'AAECAwQFBgcICQoL',
    signature:
      'Hwii/KYtoUamYQjTSfB5lolOFOdM/i4OWkozNdMjdJwDI2cIvrUQG64S3/TS23l5H9ZnsJ4KWM9Tl7+g5PenCg==',
  },
  plaintext: 'hello graine v2',
  sessionPk: '03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8',
  devicePk: '29acbae141bccaf0b22e1a94d34d0bc7361e526d0bfe12c89794bc9322966dd7',
  commitment: '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd',
  endorsement:
    '0000001863616e6172692d677261696e652d76322d656e646f727365000000066368616e2d310000000c746573742d73657373696f6e00000005616c696365000000056465762d610000002003a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b800000020630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd000001a0c4506c00',
  endorsementSignature:
    '7OosFoBLfQHHOV+1M8DysUkXqd97GXqite/EfMUyrf0X+bK/mmMaNMFohIfQvqwvr17phCTw0YAtFXmryQ7/Bg==',
};

const ENDORSEMENT: GraineEndorsementV2 = {
  channelId: 'chan-1',
  sessionId: 'test-session',
  minterUserId: 'alice',
  minterDeviceId: 'dev-a',
  signingPublicKey: unhex(V.sessionPk),
  seedCommitment: unhex(V.commitment),
  createdAt: 1790000000000,
};

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('graine v2 - the shared vectors', () => {
  it('encodes the header and the endorsement byte for byte', async () => {
    expect(hex(encodeGraineHeaderV2(HEADER))).toBe(V.header);
    expect(hex(await graineSeedCommitment(SEED))).toBe(V.commitment);
    expect(hex(encodeGraineEndorsementV2(ENDORSEMENT))).toBe(V.endorsement);
  });

  it('opens the frozen sealed message, and signs it to the same bytes', async () => {
    const plaintext = await openWithGraineV2(
      SEED,
      HEADER,
      V.sealed,
      unhex(V.sessionPk),
      webCryptoEngine
    );
    expect(decode(plaintext)).toBe(V.plaintext);
    const signed = new Uint8Array([
      ...unhex(V.header),
      ...fromBase64(V.sealed.nonce),
      ...fromBase64(V.sealed.ciphertext),
    ]);
    const signature = await webCryptoEngine.signWithSessionKey(SESSION_SECRET, signed);
    expect(toBase64(signature)).toBe(V.sealed.signature);
  });

  it('verifies the frozen endorsement against the minting device key', async () => {
    await expect(
      verifyGraineEndorsementV2(
        ENDORSEMENT,
        SEED,
        fromBase64(V.endorsementSignature),
        unhex(V.devicePk),
        webCryptoEngine
      )
    ).resolves.toBeUndefined();
  });
});

describe('graine v2 - seal and open', () => {
  it('round-trips, with a fresh nonce per message', async () => {
    const plaintext = new TextEncoder().encode('bonjour');
    const a = await sealWithGraineV2(SEED, HEADER, plaintext, SESSION_SECRET, webCryptoEngine);
    const b = await sealWithGraineV2(SEED, HEADER, plaintext, SESSION_SECRET, webCryptoEngine);
    expect(a.nonce).not.toBe(b.nonce);
    const opened = await openWithGraineV2(SEED, HEADER, a, unhex(V.sessionPk), webCryptoEngine);
    expect(decode(opened)).toBe('bonjour');
  });

  it.each([
    ['another author', { ...HEADER, minterUserId: 'mallory' }],
    ['another salon', { ...HEADER, channelId: 'chan-2' }],
    ['another index', { ...HEADER, index: 8 }],
    ['another session', { ...HEADER, sessionId: 'other-session' }],
  ])('refuses a row relabelled with %s, as a typed signature fault', async (_, header) => {
    const error = await openWithGraineV2(
      SEED,
      header,
      V.sealed,
      unhex(V.sessionPk),
      webCryptoEngine
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraineSignatureError);
    expect((error as GraineSignatureError).verdict).toBe('invalid');
  });

  it('refuses a tampered ciphertext and a signature by another session', async () => {
    const tampered = fromBase64(V.sealed.ciphertext);
    tampered[0] ^= 1;
    await expect(
      openWithGraineV2(
        SEED,
        HEADER,
        { ...V.sealed, ciphertext: toBase64(tampered) },
        unhex(V.sessionPk),
        webCryptoEngine
      )
    ).rejects.toBeInstanceOf(GraineSignatureError);
    await expect(
      openWithGraineV2(SEED, HEADER, V.sealed, unhex(V.devicePk), webCryptoEngine)
    ).rejects.toBeInstanceOf(GraineSignatureError);
  });

  it('refuses a truncated signature as malformed, not as invalid', async () => {
    const error = await openWithGraineV2(
      SEED,
      HEADER,
      { ...V.sealed, signature: toBase64(fromBase64(V.sealed.signature).slice(0, 63)) },
      unhex(V.sessionPk),
      webCryptoEngine
    ).catch((e: unknown) => e);
    expect((error as GraineSignatureError).verdict).toBe('malformed-signature');
  });

  it('rejects the wrong seed in AES-GCM once the signature has passed - a different fault', async () => {
    const error = await openWithGraineV2(
      range(1, 32),
      HEADER,
      V.sealed,
      unhex(V.sessionPk),
      webCryptoEngine
    ).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(GraineSignatureError);
    expect(error).toBeInstanceOf(Error);
  });
});

describe('graine v2 - endorsements', () => {
  const signature = () => fromBase64(V.endorsementSignature);

  it('refuses a seed that is not the one endorsed, before any signature check', async () => {
    const error = await verifyGraineEndorsementV2(
      ENDORSEMENT,
      range(1, 32),
      signature(),
      unhex(V.devicePk),
      webCryptoEngine
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraineSignatureError);
  });

  it('refuses an endorsement signed by another device, or naming another key', async () => {
    await expect(
      verifyGraineEndorsementV2(ENDORSEMENT, SEED, signature(), unhex(V.sessionPk), webCryptoEngine)
    ).rejects.toBeInstanceOf(GraineSignatureError);
    await expect(
      verifyGraineEndorsementV2(
        { ...ENDORSEMENT, signingPublicKey: unhex(V.devicePk) },
        SEED,
        signature(),
        unhex(V.devicePk),
        webCryptoEngine
      )
    ).rejects.toBeInstanceOf(GraineSignatureError);
  });
});

describe('graine v2 - inputs that cannot be bound', () => {
  it('refuses an empty field, an out-of-range index and a mis-sized key before any crypto', () => {
    expect(() => encodeGraineHeaderV2({ ...HEADER, minterUserId: '' })).toThrow(GraineInputError);
    expect(() => encodeGraineHeaderV2({ ...HEADER, index: -1 })).toThrow(GraineInputError);
    expect(() => encodeGraineHeaderV2({ ...HEADER, index: 2 ** 32 })).toThrow(GraineInputError);
    expect(() =>
      encodeGraineEndorsementV2({ ...ENDORSEMENT, signingPublicKey: range(0, 31) })
    ).toThrow(GraineInputError);
    expect(() => encodeGraineEndorsementV2({ ...ENDORSEMENT, minterDeviceId: '' })).toThrow(
      GraineInputError
    );
  });

  it('never lets two different headers encode to the same bytes', () => {
    const a = encodeGraineHeaderV2({ ...HEADER, channelId: 'ab', sessionId: 'c' });
    const b = encodeGraineHeaderV2({ ...HEADER, channelId: 'a', sessionId: 'bc' });
    expect(hex(a)).not.toBe(hex(b));
  });
});
