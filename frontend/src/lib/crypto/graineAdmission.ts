/**
 * A community admission a member can VERIFY: the statements a device signs to vouch that somebody was
 * admitted, and the two wire forms that carry them - the voucher stored with a membership, and the
 * invite link's fragment (channel-encryption section 25).
 *
 * A member hands a community's past - every Graine seed it holds - only to a newcomer whose admission
 * it can check itself, never on the server's word: the server keeps the roster, and a roster is
 * exactly what an honest member must not have to believe to decide who reads the past.
 *
 * Two ways in are proven, one per way a newcomer actually arrives:
 *
 * - DIRECT: a member's device adds them from the community panel and signs `A` - the community, the
 *   newcomer, itself and the instant - with its MLS credential key, the key its leaf in the key group
 *   carries, so no new key is distributed or trusted.
 * - LINK: the member's device that SHOWS an invite link mints an Ed25519 pair for it, signs `L` - the
 *   community, itself, the link's public key and the instant - and puts `L`, its signature and the
 *   link's SECRET in the URL fragment, which a browser never sends to a server. The newcomer signs
 *   `R` - the community, themselves, the link's public key - with that secret. The voucher carries
 *   `L`'s fields, both signatures, and verifies with no secret at all.
 *
 * Every structure begins with its own length-prefixed label, as Graine v2's do: the label keeps one
 * signature from ever verifying as another, and its leading `0x00` keeps the device key's signature
 * from ever being an MLS `SignContent` (`mls-core/src/graine_signature.rs`).
 *
 * Pure: every input is an argument, and Ed25519 arrives through the {@link GraineSignatureEngine}
 * seam, as Graine v2's does.
 */

import { GraineFieldWriter, type GraineSignatureEngine } from '$lib/crypto/graineV2';
import { GRAINE_PUBLIC_KEY_BYTES, GRAINE_SIGNATURE_BYTES } from '$lib/crypto/graineConstants';

/** `A`'s label: a member's device admitted somebody directly. */
export const ADMISSION_DIRECT_LABEL = 'canari-graine-admit-direct-v1';
/** `L`'s label: a member's device stands behind an invite link's key. */
export const ADMISSION_LINK_LABEL = 'canari-graine-admit-link-v1';
/** `R`'s label: the holder of an invite link's key admits one person with it. */
export const ADMISSION_REDEEM_LABEL = 'canari-graine-admit-redeem-v1';
/** The voucher's own label - never signed, it only names the encoding. */
const VOUCHER_LABEL = 'canari-graine-admission-v1';
/** The invite fragment's label - never signed, it only names the encoding. */
const INVITE_GRANT_LABEL = 'canari-graine-invite-v1';
/** An Ed25519 secret in the 32-byte seed form the engine mints. */
const LINK_SECRET_BYTES = 32;

/**
 * How long an invite link's grant admits when the link itself never expires: 30 days (user,
 * 2026-10-23). The fragment is a bearer proof, and one that never ends is one nobody can take back.
 */
export const LINK_GRANT_DEFAULT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const KIND_DIRECT = 1;
const KIND_LINK = 2;

/** A malformed voucher or fragment. Typed so a caller classifies it by class, never by sentence. */
export class AdmissionFormatError extends Error {
  constructor(what: string) {
    super(`admission ${what}`);
    this.name = 'AdmissionFormatError';
  }
}

/** The device that vouches: a member's user and one of its devices, as its key-group leaf names it. */
export interface AdmissionSigner {
  userId: string;
  deviceId: string;
}

/**
 * WHERE in the community's history an admission was signed: the key group the signer held and its
 * epoch then. The shared clock every member of the key group agrees on - so a member that saw the
 * newcomer's leaves LEAVE the tree at a later epoch knows the voucher predates that removal and
 * admits nobody any more (a kicked member coming back with their old voucher), and a voucher whose
 * signer was admitted at that epoch still counts after the signer leaves.
 */
export interface AdmissionPlace {
  keyGroupId: string;
  epoch: number;
}

/** A member's device admitted `subjectUserId` from the community panel. */
export interface DirectAdmissionVoucher {
  kind: 'direct';
  workspaceId: string;
  subjectUserId: string;
  signer: AdmissionSigner;
  place: AdmissionPlace;
  /** Milliseconds since the epoch: the signer's claim, bound into `A`, deciding nothing. */
  issuedAt: number;
  /** The signer device's credential signature over `A`. */
  signature: Uint8Array;
}

/** `subjectUserId` followed an invite link that a member's device stood behind. */
export interface LinkAdmissionVoucher {
  kind: 'link';
  workspaceId: string;
  subjectUserId: string;
  /** The device that showed the link and signed `L`. */
  signer: AdmissionSigner;
  /** Where the link was signed - an admission through it is placed there, however late it is used. */
  place: AdmissionPlace;
  /** When `L` was signed - the signer's claim, bound into `L`. */
  issuedAt: number;
  /** Until when the link admits (ms since the epoch), signed into `L` - see {@link InviteLinkGrant}. */
  expiresAt: number;
  linkPublicKey: Uint8Array;
  /** The signer device's credential signature over `L`. */
  linkSignature: Uint8Array;
  /** The link key's signature over `R`. */
  redemptionSignature: Uint8Array;
}

export type AdmissionVoucher = DirectAdmissionVoucher | LinkAdmissionVoucher;

/** What an invite link's fragment carries: `L`, its signature, and the secret that signs `R`. */
export interface InviteLinkGrant {
  workspaceId: string;
  signer: AdmissionSigner;
  place: AdmissionPlace;
  issuedAt: number;
  /**
   * Until when the link admits (ms since the epoch): the invite link's own expiry, or
   * {@link LINK_GRANT_DEFAULT_LIFETIME_MS} after `issuedAt` when the link has none. Signed into `L`,
   * so no holder of the fragment can extend it; a member compares it with the instant IT first
   * observed the voucher.
   */
  expiresAt: number;
  linkPublicKey: Uint8Array;
  linkSignature: Uint8Array;
  linkSecret: Uint8Array;
}

/**
 * `A = lp(label) || lp(workspaceId) || lp(subject) || lp(signerUser) || lp(signerDevice) ||
 * lp(keyGroupId) || be64(epoch) || be64(issuedAt)`.
 */
export function encodeDirectAdmission(
  v: Pick<DirectAdmissionVoucher, 'workspaceId' | 'subjectUserId' | 'signer' | 'place' | 'issuedAt'>
): Uint8Array {
  const out = new GraineFieldWriter();
  out.field(utf8(ADMISSION_DIRECT_LABEL));
  out.field(text('workspaceId', v.workspaceId));
  out.field(text('subjectUserId', v.subjectUserId));
  out.field(text('signer.userId', v.signer.userId));
  out.field(text('signer.deviceId', v.signer.deviceId));
  writePlace(out, v.place);
  out.u64(instant(v.issuedAt));
  return out.bytes();
}

/**
 * `L = lp(label) || lp(workspaceId) || lp(signerUser) || lp(signerDevice) || lp(keyGroupId) ||
 * be64(epoch) || lp(linkPublicKey) || be64(issuedAt) || be64(expiresAt)`.
 */
export function encodeLinkAdmission(
  v: Pick<
    InviteLinkGrant,
    'workspaceId' | 'signer' | 'place' | 'issuedAt' | 'expiresAt' | 'linkPublicKey'
  >
): Uint8Array {
  const out = new GraineFieldWriter();
  out.field(utf8(ADMISSION_LINK_LABEL));
  out.field(text('workspaceId', v.workspaceId));
  out.field(text('signer.userId', v.signer.userId));
  out.field(text('signer.deviceId', v.signer.deviceId));
  writePlace(out, v.place);
  out.field(sized('linkPublicKey', v.linkPublicKey, GRAINE_PUBLIC_KEY_BYTES));
  out.u64(instant(v.issuedAt));
  out.u64(instant(v.expiresAt));
  return out.bytes();
}

/** `R = lp(label) || lp(workspaceId) || lp(subject) || lp(linkPublicKey)`. */
export function encodeLinkRedemption(
  workspaceId: string,
  subjectUserId: string,
  linkPublicKey: Uint8Array
): Uint8Array {
  const out = new GraineFieldWriter();
  out.field(utf8(ADMISSION_REDEEM_LABEL));
  out.field(text('workspaceId', workspaceId));
  out.field(text('subjectUserId', subjectUserId));
  out.field(sized('linkPublicKey', linkPublicKey, GRAINE_PUBLIC_KEY_BYTES));
  return out.bytes();
}

/**
 * Mints the grant an invite link carries: a fresh link key pair, `L` signed by THIS device's
 * credential key (`signWithDevice`). Nothing is stored - every display of a link may mint its own,
 * and every one of them is valid on its own, until `expiresAt`.
 */
export async function mintInviteLinkGrant(
  workspaceId: string,
  signer: AdmissionSigner,
  place: AdmissionPlace,
  issuedAt: number,
  expiresAt: number,
  engine: GraineSignatureEngine,
  signWithDevice: (message: Uint8Array) => Promise<Uint8Array>
): Promise<InviteLinkGrant> {
  const { secret, publicKey } = await engine.newSessionKeyPair();
  const linkSignature = await signWithDevice(
    encodeLinkAdmission({
      workspaceId,
      signer,
      place,
      issuedAt,
      expiresAt,
      linkPublicKey: publicKey,
    })
  );
  return {
    workspaceId,
    signer,
    place,
    issuedAt,
    expiresAt,
    linkPublicKey: publicKey,
    linkSignature,
    linkSecret: secret,
  };
}

/** Turns a link's grant into the voucher of the one person following it, signing `R` with its secret. */
export async function redeemInviteLinkGrant(
  grant: InviteLinkGrant,
  subjectUserId: string,
  engine: GraineSignatureEngine
): Promise<LinkAdmissionVoucher> {
  const redemptionSignature = await engine.signWithSessionKey(
    grant.linkSecret,
    encodeLinkRedemption(grant.workspaceId, subjectUserId, grant.linkPublicKey)
  );
  return {
    kind: 'link',
    workspaceId: grant.workspaceId,
    subjectUserId,
    signer: grant.signer,
    place: grant.place,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    linkPublicKey: grant.linkPublicKey,
    linkSignature: grant.linkSignature,
    redemptionSignature,
  };
}

/**
 * Checks a voucher's signatures against `signerKey`, the signer device's credential key - the one the
 * caller pinned from a key-group tree, never one the server publishes alone. Who the signer IS -
 * whether their own admission holds - is the caller's question, not this function's.
 *
 * @returns whether every signature the voucher carries verifies.
 */
export async function voucherSignaturesHold(
  voucher: AdmissionVoucher,
  signerKey: Uint8Array,
  engine: GraineSignatureEngine
): Promise<boolean> {
  if (voucher.kind === 'direct') {
    return (
      (await engine.verifySignature(
        signerKey,
        encodeDirectAdmission(voucher),
        voucher.signature
      )) === 'valid'
    );
  }
  const link = await engine.verifySignature(
    signerKey,
    encodeLinkAdmission(voucher),
    voucher.linkSignature
  );
  if (link !== 'valid') return false;
  const redemption = await engine.verifySignature(
    voucher.linkPublicKey,
    encodeLinkRedemption(voucher.workspaceId, voucher.subjectUserId, voucher.linkPublicKey),
    voucher.redemptionSignature
  );
  return redemption === 'valid';
}

/** The voucher as the opaque base64url string the server stores. */
export function encodeAdmissionVoucher(voucher: AdmissionVoucher): string {
  const out = new GraineFieldWriter();
  out.field(utf8(VOUCHER_LABEL));
  out.u32(voucher.kind === 'direct' ? KIND_DIRECT : KIND_LINK);
  out.field(text('workspaceId', voucher.workspaceId));
  out.field(text('subjectUserId', voucher.subjectUserId));
  out.field(text('signer.userId', voucher.signer.userId));
  out.field(text('signer.deviceId', voucher.signer.deviceId));
  writePlace(out, voucher.place);
  out.u64(instant(voucher.issuedAt));
  if (voucher.kind === 'direct') {
    out.field(sized('signature', voucher.signature, GRAINE_SIGNATURE_BYTES));
  } else {
    out.u64(instant(voucher.expiresAt));
    out.field(sized('linkPublicKey', voucher.linkPublicKey, GRAINE_PUBLIC_KEY_BYTES));
    out.field(sized('linkSignature', voucher.linkSignature, GRAINE_SIGNATURE_BYTES));
    out.field(sized('redemptionSignature', voucher.redemptionSignature, GRAINE_SIGNATURE_BYTES));
  }
  return toBase64Url(out.bytes());
}

/** Reads a stored voucher back. @throws {@link AdmissionFormatError} on anything malformed. */
export function decodeAdmissionVoucher(encoded: string): AdmissionVoucher {
  const r = new FieldReader(fromBase64Url(encoded));
  if (r.string() !== VOUCHER_LABEL) throw new AdmissionFormatError('voucher: unknown label');
  const kind = r.u32();
  const workspaceId = r.string();
  const subjectUserId = r.string();
  const signer = { userId: r.string(), deviceId: r.string() };
  const place = r.place();
  const issuedAt = r.u64();
  let voucher: AdmissionVoucher;
  if (kind === KIND_DIRECT) {
    voucher = {
      kind: 'direct',
      workspaceId,
      subjectUserId,
      signer,
      place,
      issuedAt,
      signature: r.sized(GRAINE_SIGNATURE_BYTES),
    };
  } else if (kind === KIND_LINK) {
    voucher = {
      kind: 'link',
      workspaceId,
      subjectUserId,
      signer,
      place,
      issuedAt,
      expiresAt: r.u64(),
      linkPublicKey: r.sized(GRAINE_PUBLIC_KEY_BYTES),
      linkSignature: r.sized(GRAINE_SIGNATURE_BYTES),
      redemptionSignature: r.sized(GRAINE_SIGNATURE_BYTES),
    };
  } else {
    throw new AdmissionFormatError(`voucher: unknown kind ${kind}`);
  }
  r.end();
  if (!workspaceId || !subjectUserId || !signer.userId || !signer.deviceId || !place.keyGroupId) {
    throw new AdmissionFormatError('voucher: an empty identity');
  }
  return voucher;
}

/** The grant as the invite link's fragment (base64url, no `#`). It carries a SECRET. */
export function encodeInviteLinkGrant(grant: InviteLinkGrant): string {
  const out = new GraineFieldWriter();
  out.field(utf8(INVITE_GRANT_LABEL));
  out.field(text('workspaceId', grant.workspaceId));
  out.field(text('signer.userId', grant.signer.userId));
  out.field(text('signer.deviceId', grant.signer.deviceId));
  writePlace(out, grant.place);
  out.u64(instant(grant.issuedAt));
  out.u64(instant(grant.expiresAt));
  out.field(sized('linkPublicKey', grant.linkPublicKey, GRAINE_PUBLIC_KEY_BYTES));
  out.field(sized('linkSignature', grant.linkSignature, GRAINE_SIGNATURE_BYTES));
  out.field(sized('linkSecret', grant.linkSecret, LINK_SECRET_BYTES));
  return toBase64Url(out.bytes());
}

/** Reads an invite link's fragment. @throws {@link AdmissionFormatError} on anything malformed. */
export function decodeInviteLinkGrant(fragment: string): InviteLinkGrant {
  const r = new FieldReader(fromBase64Url(fragment.replace(/^#/, '')));
  if (r.string() !== INVITE_GRANT_LABEL) throw new AdmissionFormatError('fragment: unknown label');
  const grant: InviteLinkGrant = {
    workspaceId: r.string(),
    signer: { userId: r.string(), deviceId: r.string() },
    place: r.place(),
    issuedAt: r.u64(),
    expiresAt: r.u64(),
    linkPublicKey: r.sized(GRAINE_PUBLIC_KEY_BYTES),
    linkSignature: r.sized(GRAINE_SIGNATURE_BYTES),
    linkSecret: r.sized(LINK_SECRET_BYTES),
  };
  r.end();
  if (
    !grant.workspaceId ||
    !grant.signer.userId ||
    !grant.signer.deviceId ||
    !grant.place.keyGroupId
  ) {
    throw new AdmissionFormatError('fragment: an empty identity');
  }
  return grant;
}

/** Reads what {@link GraineFieldWriter} writes; every overrun is an {@link AdmissionFormatError}. */
class FieldReader {
  private at = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.at, false);
    this.at += 4;
    return v;
  }

  u64(): number {
    this.need(8);
    const v = this.view.getBigUint64(this.at, false);
    this.at += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new AdmissionFormatError('an instant overflows');
    return Number(v);
  }

  field(): Uint8Array {
    const length = this.u32();
    this.need(length);
    const out = this.bytes.slice(this.at, this.at + length);
    this.at += length;
    return out;
  }

  sized(length: number): Uint8Array {
    const out = this.field();
    if (out.length !== length) {
      throw new AdmissionFormatError(`a ${length}-byte field holds ${out.length}`);
    }
    return out;
  }

  string(): string {
    const bytes = this.field();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // The decoder's own TypeError, classified HERE as the format error it is: a caller sorts a
      // malformed voucher by class, and must never meet a second kind of exception for one.
      throw new AdmissionFormatError('a text field is not UTF-8');
    }
  }

  place(): AdmissionPlace {
    return { keyGroupId: this.string(), epoch: this.u64() };
  }

  end(): void {
    if (this.at !== this.bytes.length) throw new AdmissionFormatError('trailing bytes');
  }

  private need(length: number): void {
    if (this.at + length > this.bytes.length) throw new AdmissionFormatError('truncated');
  }
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function text(name: string, value: string): Uint8Array {
  if (!value) throw new AdmissionFormatError(`${name} is required`);
  return utf8(value);
}

function sized(name: string, value: Uint8Array, length: number): Uint8Array {
  if (value.length !== length) {
    throw new AdmissionFormatError(`${name} must be ${length} bytes, got ${value.length}`);
  }
  return value;
}

function writePlace(out: GraineFieldWriter, place: AdmissionPlace): void {
  out.field(text('place.keyGroupId', place.keyGroupId));
  out.u64(instant(place.epoch));
}

function instant(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AdmissionFormatError(
      `an instant or an epoch must be a non-negative integer, got ${value}`
    );
  }
  return value;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new AdmissionFormatError('not base64url');
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  } catch {
    throw new AdmissionFormatError('not base64url');
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
