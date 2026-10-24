/**
 * Graine v2: a ciphertext bound to its place, and signed by the session that sealed it.
 *
 * v1 (`graine.ts`) hides the content and proves nothing else: a ciphertext is bound to no salon, no
 * author and no position, and anyone holding the symmetric seed can write under the minter's name.
 * v2 keeps the v1 key derivation and adds, per message, a HEADER used as AES-GCM additional data
 * and an Ed25519 SIGNATURE by the session's own key; per session, an ENDORSEMENT by the minting
 * device's MLS credential key, binding the session key and the seed to the device that minted them.
 *
 * Pure like `graine.ts`: every input is an argument. The Ed25519 half is not WebCrypto - it reached
 * the browsers late and unevenly, and the WebViews a phone ships are older still - so it arrives as
 * a {@link GraineSignatureEngine}, implemented by the Rust engine (`mls-core/src/graine_signature.rs`)
 * on every platform.
 *
 * Every encoding here is mirrored by the native `mobile/graine.rs`, which opens a push before any
 * WebView runs; the vectors in `graineV2.test.ts` and in that file are the contract between the two.
 *
 * Protocol: `docs/wiki/protocols/channel-encryption.md` §21.
 */

import { deriveMessageKey, GraineInputError, type GraineSealed } from '$lib/crypto/graine';
import {
  GRAINE_NONCE_BYTES,
  GRAINE_PUBLIC_KEY_BYTES,
  GRAINE_SEED_BYTES,
  GRAINE_SIGNATURE_BYTES,
  GRAINE_V2_ENDORSEMENT_LABEL,
  GRAINE_V2_HEADER_LABEL,
} from '$lib/crypto/graineConstants';
import { fromBase64, toBase64 } from '$lib/utils/hex';

/**
 * What the Rust engine answers about a signature. `valid` is the only success; the rest are the
 * engine's own codes (`GraineSignatureError::code`), so a caller classifies on a value, never on a
 * sentence.
 */
export type GraineSignatureVerdict =
  | 'valid'
  | 'invalid'
  | 'malformed-public-key'
  | 'malformed-signature';

/** The Ed25519 operations v2 needs, supplied by the platform's MLS engine. */
export interface GraineSignatureEngine {
  /** Mints a v2 session key pair (Ed25519): the secret stays with the minter, the public half travels. */
  newSessionKeyPair(): Promise<{ secret: Uint8Array; publicKey: Uint8Array }>;
  /** Signs with a session secret (Ed25519, deterministic). */
  signWithSessionKey(secret: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
  /** Verifies a session's or a device's signature; ONE verifier, since only the key's origin differs. */
  verifySignature(
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array
  ): Promise<GraineSignatureVerdict>;
  /**
   * Verifies a whole page's signatures in ONE call to the engine (F7): one verdict per check, in
   * order, each exactly what {@link verifySignature} answers for it - one refused check changes
   * nothing about its neighbours. What it saves is the bridge, one crossing instead of one per row.
   * Rejects only when the call itself fails, never for a signature that does not verify.
   */
  verifySignatures(checks: readonly GraineSignatureCheck[]): Promise<GraineSignatureVerdict[]>;
}

/** Every verdict an engine may answer, the runtime copy of {@link GraineSignatureVerdict}. */
const GRAINE_SIGNATURE_VERDICTS: ReadonlySet<string> = new Set<GraineSignatureVerdict>([
  'valid',
  'invalid',
  'malformed-public-key',
  'malformed-signature',
]);

/**
 * An engine's batch answer that is not one known verdict per check - a broken bridge contract,
 * never a verdict about any signature. Typed so a page refuses the whole batch on a CLASS: a
 * verdict handed to the wrong row would be a forged row shown.
 */
export class GraineSignatureBatchError extends Error {
  constructor(readonly detail: string) {
    super(`Graine v2 signature batch answer refused: ${detail}`);
    this.name = 'GraineSignatureBatchError';
  }
}

/**
 * Checks the SHAPE of a `verifySignatures` answer: an array of exactly `expected` entries, each a
 * known verdict string. What crosses the Tauri bridge or leaves WASM is untyped at runtime, so the
 * cast is not a proof. @throws {GraineSignatureBatchError} on anything else.
 */
export function requireGraineVerdicts(answer: unknown, expected: number): GraineSignatureVerdict[] {
  if (!Array.isArray(answer)) {
    throw new GraineSignatureBatchError(`not an array (${typeof answer})`);
  }
  if (answer.length !== expected) {
    throw new GraineSignatureBatchError(`${answer.length} verdict(s) for ${expected} check(s)`);
  }
  const unknown = answer.findIndex(
    (v) => typeof v !== 'string' || !GRAINE_SIGNATURE_VERDICTS.has(v)
  );
  if (unknown !== -1) {
    throw new GraineSignatureBatchError(
      `entry ${unknown} is not a known verdict (${JSON.stringify(answer[unknown])})`
    );
  }
  return answer as GraineSignatureVerdict[];
}

/** One signature to check inside a batch - the three arguments of `verifySignature`. */
export interface GraineSignatureCheck {
  publicKey: Uint8Array;
  message: Uint8Array;
  signature: Uint8Array;
}

/**
 * The bytes a batch crosses the bridge as: `be32(count)`, then per check `lp(publicKey) ||
 * lp(message) || lp(signature)`, every `lp` a 4-byte big-endian length. ONE buffer, so the Tauri
 * call carries one base64 string and the WASM call one slice, instead of three JSON number arrays
 * per row. Decoded by `unpack_graine_signature_checks` (`mls-core/src/graine_signature.rs`); the
 * shared vector in `graineV2.test.ts` and in that file pins the two together.
 */
export function packGraineSignatureChecks(checks: readonly GraineSignatureCheck[]): Uint8Array {
  const out = new GraineFieldWriter();
  out.u32(checks.length);
  for (const check of checks) {
    out.field(check.publicKey);
    out.field(check.message);
    out.field(check.signature);
  }
  return out.bytes();
}

/**
 * A v2 signature that did not verify - a forged author, a row moved to another salon or index, a
 * tampered ciphertext, or a key that is not the session's. Typed so the unreadable-row accounting
 * files it as a FAULT: a repair would hand back the same seed and change nothing.
 */
export class GraineSignatureError extends Error {
  constructor(
    readonly verdict: Exclude<GraineSignatureVerdict, 'valid'>,
    what: string
  ) {
    super(`Graine v2 ${what} signature refused: ${verdict}`);
    this.name = 'GraineSignatureError';
  }
}

/** Where a v2 message belongs: every field is bound into its additional data and its signature. */
export interface GraineMessageHeaderV2 {
  channelId: string;
  sessionId: string;
  /** The session's minter, who is therefore the only author a row under it may name. */
  minterUserId: string;
  index: number;
}

/** What a v2 session's minter endorses, once, with its device credential key. */
export interface GraineEndorsementV2 {
  channelId: string;
  sessionId: string;
  minterUserId: string;
  minterDeviceId: string;
  /** The session's Ed25519 public key. */
  signingPublicKey: Uint8Array;
  /** {@link graineSeedCommitment} of the session's seed. */
  seedCommitment: Uint8Array;
  /** Milliseconds since the epoch, as `StoredGraineSession.createdAt`. */
  createdAt: number;
}

/** A v2 sealed message: v1's two fields plus the session's signature, base64 for a JSON body. */
export interface GraineSealedV2 extends GraineSealed {
  signature: string;
}

/**
 * `H`, the header: `lp(label) || lp(channelId) || lp(sessionId) || lp(minterUserId) || be32(index)`,
 * every string UTF-8 and every `lp` a 4-byte big-endian length. Length-prefixed rather than joined,
 * so no two different headers can produce the same bytes.
 */
export function encodeGraineHeaderV2(header: GraineMessageHeaderV2): Uint8Array {
  requireText('channelId', header.channelId);
  requireText('sessionId', header.sessionId);
  requireText('minterUserId', header.minterUserId);
  requireIndex(header.index);
  const out = new GraineFieldWriter();
  out.field(utf8(GRAINE_V2_HEADER_LABEL));
  out.field(utf8(header.channelId));
  out.field(utf8(header.sessionId));
  out.field(utf8(header.minterUserId));
  out.u32(header.index);
  return out.bytes();
}

/**
 * `D`, the endorsement descriptor: `lp(label) || lp(channelId) || lp(sessionId) || lp(minterUserId)
 * || lp(minterDeviceId) || lp(signingPublicKey) || lp(seedCommitment) || be64(createdAt)`.
 *
 * The SEED COMMITMENT is what makes a relayed seed checkable. Without it the endorsement proves the
 * session key and says nothing about the seed, so the first member to relay a session to a newcomer
 * could hand it other bytes - and since a held seed is never replaced, the right one would then be
 * refused when it came. With it, the wrong seed is refused on arrival and the right one still lands.
 */
export function encodeGraineEndorsementV2(endorsement: GraineEndorsementV2): Uint8Array {
  requireText('channelId', endorsement.channelId);
  requireText('sessionId', endorsement.sessionId);
  requireText('minterUserId', endorsement.minterUserId);
  requireText('minterDeviceId', endorsement.minterDeviceId);
  requireLength('signingPublicKey', endorsement.signingPublicKey, GRAINE_PUBLIC_KEY_BYTES);
  requireLength('seedCommitment', endorsement.seedCommitment, 32);
  if (!Number.isSafeInteger(endorsement.createdAt) || endorsement.createdAt < 0) {
    throw new GraineInputError(
      `createdAt must be a non-negative integer, got ${endorsement.createdAt}`
    );
  }
  const out = new GraineFieldWriter();
  out.field(utf8(GRAINE_V2_ENDORSEMENT_LABEL));
  out.field(utf8(endorsement.channelId));
  out.field(utf8(endorsement.sessionId));
  out.field(utf8(endorsement.minterUserId));
  out.field(utf8(endorsement.minterDeviceId));
  out.field(endorsement.signingPublicKey);
  out.field(endorsement.seedCommitment);
  out.u64(endorsement.createdAt);
  return out.bytes();
}

/** SHA-256 of the seed - safe to carry beside it, since a 32-byte random seed cannot be guessed. */
export async function graineSeedCommitment(seed: Uint8Array): Promise<Uint8Array> {
  requireLength('seed', seed, GRAINE_SEED_BYTES);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', seed as BufferSource));
}

/** What the session key signs: `H || nonce || ciphertext` - `H` delimits itself and the nonce is fixed-width. */
export function graineSignedBytesV2(
  header: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array
): Uint8Array {
  requireLength('nonce', nonce, GRAINE_NONCE_BYTES);
  const out = new Uint8Array(header.length + nonce.length + ciphertext.length);
  out.set(header, 0);
  out.set(nonce, header.length);
  out.set(ciphertext, header.length + nonce.length);
  return out;
}

/**
 * Seals `plaintext` as message `header.index` of a v2 session: AES-GCM under v1's derived key with
 * `H` as additional data, then signed by the session secret. A fresh random nonce per message, for
 * v1's reason.
 */
export async function sealWithGraineV2(
  seed: Uint8Array,
  header: GraineMessageHeaderV2,
  plaintext: Uint8Array,
  sessionSecret: Uint8Array,
  engine: GraineSignatureEngine
): Promise<GraineSealedV2> {
  const h = encodeGraineHeaderV2(header);
  const key = await deriveMessageKey(seed, header.sessionId, header.index);
  const nonce = crypto.getRandomValues(new Uint8Array(GRAINE_NONCE_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: h as BufferSource },
      key,
      plaintext as BufferSource
    )
  );
  const signature = await engine.signWithSessionKey(
    sessionSecret,
    graineSignedBytesV2(h, nonce, ciphertext)
  );
  return {
    ciphertext: toBase64(ciphertext),
    nonce: toBase64(nonce),
    signature: toBase64(signature),
  };
}

/**
 * Opens a message sealed by {@link sealWithGraineV2}.
 *
 * The signature is checked FIRST, against the session's endorsed public key: it covers the header,
 * so a row relabelled with another author, salon or index fails here, before any key is derived,
 * with a typed {@link GraineSignatureError}. A wrong seed that passes it rejects in AES-GCM, as in
 * v1 - the two are different faults and stay distinguishable.
 */
export async function openWithGraineV2(
  seed: Uint8Array,
  header: GraineMessageHeaderV2,
  sealed: GraineSealedV2,
  signingPublicKey: Uint8Array,
  engine: GraineSignatureEngine
): Promise<Uint8Array> {
  const prepared = prepareGraineV2Open(header, sealed, signingPublicKey);
  const verdict = await engine.verifySignature(
    prepared.check.publicKey,
    prepared.check.message,
    prepared.check.signature
  );
  return finishGraineV2Open(seed, prepared, verdict);
}

/**
 * The first half of {@link openWithGraineV2}, everything before the signature check: the header
 * encoded, the three fields decoded, the signature's length checked, the signed bytes built. Split
 * out so a PAGE can gather every row's check and ask the engine once (`openChannelMessagePage`),
 * while the single open and the page run the same code, in the same order, with the same throws.
 */
export interface PreparedGraineV2Open {
  readonly header: GraineMessageHeaderV2;
  /** `H`, the additional data the decrypt binds. */
  readonly encodedHeader: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  /** What the engine is asked: the session key, `H || nonce || ciphertext`, the signature. */
  readonly check: GraineSignatureCheck;
}

/** See {@link PreparedGraineV2Open}. Throws exactly what {@link openWithGraineV2} throws before its check. */
export function prepareGraineV2Open(
  header: GraineMessageHeaderV2,
  sealed: GraineSealedV2,
  signingPublicKey: Uint8Array
): PreparedGraineV2Open {
  const encodedHeader = encodeGraineHeaderV2(header);
  const nonce = fromBase64(sealed.nonce);
  const ciphertext = fromBase64(sealed.ciphertext);
  const signature = fromBase64(sealed.signature);
  if (signature.length !== GRAINE_SIGNATURE_BYTES) {
    throw new GraineSignatureError('malformed-signature', 'message');
  }
  return {
    header,
    encodedHeader,
    nonce,
    ciphertext,
    check: {
      publicKey: signingPublicKey,
      message: graineSignedBytesV2(encodedHeader, nonce, ciphertext),
      signature,
    },
  };
}

/**
 * The second half of {@link openWithGraineV2}: refuses anything but a `valid` verdict with a typed
 * {@link GraineSignatureError}, then derives the key and decrypts. The verdict must be the engine's
 * answer for `prepared.check` and no other - a page hands each row its own, by position.
 */
export async function finishGraineV2Open(
  seed: Uint8Array,
  prepared: PreparedGraineV2Open,
  verdict: GraineSignatureVerdict
): Promise<Uint8Array> {
  // Not logged here: the caller reports the row as a FAULT, once per page (`reportUnreadableChannelMessage`).
  if (verdict !== 'valid') throw new GraineSignatureError(verdict, 'message');
  const key = await deriveMessageKey(seed, prepared.header.sessionId, prepared.header.index);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: prepared.nonce as BufferSource,
      additionalData: prepared.encodedHeader as BufferSource,
    },
    key,
    prepared.ciphertext as BufferSource
  );
  return new Uint8Array(plaintext);
}

/**
 * Checks a session's endorsement against the minting device's credential key, and the seed it came
 * with against the commitment the endorsement carries. Throws a typed {@link GraineSignatureError}
 * on either; a session that fails this must never be stored, not even half.
 */
export async function verifyGraineEndorsementV2(
  endorsement: GraineEndorsementV2,
  seed: Uint8Array,
  signature: Uint8Array,
  devicePublicKey: Uint8Array,
  engine: GraineSignatureEngine
): Promise<void> {
  const commitment = await graineSeedCommitment(seed);
  if (!sameBytes(commitment, endorsement.seedCommitment)) {
    console.error(
      `[GRAINE] v2 endorsement refused: the seed is not the one endorsed session=${endorsement.sessionId.slice(0, 8)}`
    );
    throw new GraineSignatureError('invalid', 'endorsement seed');
  }
  const verdict = await engine.verifySignature(
    devicePublicKey,
    encodeGraineEndorsementV2(endorsement),
    signature
  );
  if (verdict !== 'valid') {
    console.error(
      `[GRAINE] v2 endorsement refused (${verdict}) session=${endorsement.sessionId.slice(0, 8)} minter=${endorsement.minterUserId.slice(0, 8)}:${endorsement.minterDeviceId.slice(0, 8)}`
    );
    throw new GraineSignatureError(verdict, 'endorsement');
  }
}

/**
 * Appends length-prefixed fields and fixed-width integers, big-endian. Exported for the other Graine
 * structures a device credential signs (`graineAdmission.ts`), which must begin the same way: a
 * 4-byte length whose first byte is `0x00`, the property that keeps them from ever being an MLS
 * `SignContent` (`mls-core/src/graine_signature.rs`) - and for the author proofs of
 * `messageAuthorship.ts`, whose descriptor shares this encoding.
 */
export class GraineFieldWriter {
  private readonly parts: Uint8Array[] = [];

  field(bytes: Uint8Array): void {
    this.u32(bytes.length);
    this.parts.push(bytes);
  }

  u32(value: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value, false);
    this.parts.push(b);
  }

  u64(value: number): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(value), false);
    this.parts.push(b);
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function requireText(name: string, value: string): void {
  if (!value) throw new GraineInputError(`${name} is required: it is bound into Graine v2`);
}

function requireIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new GraineInputError(`Message index must be a uint32, got ${index}`);
  }
}

function requireLength(name: string, bytes: Uint8Array, length: number): void {
  if (bytes.length !== length) {
    throw new GraineInputError(`${name} must be ${length} bytes, got ${bytes.length}`);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
