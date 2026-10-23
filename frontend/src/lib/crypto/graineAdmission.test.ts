import { ed25519PublicKeyOf, webCryptoEngine } from '$lib/crypto/graineV2.testEngine';
import {
  AdmissionFormatError,
  decodeAdmissionVoucher,
  decodeInviteLinkGrant,
  encodeAdmissionVoucher,
  encodeDirectAdmission,
  encodeInviteLinkGrant,
  encodeLinkAdmission,
  encodeLinkRedemption,
  mintInviteLinkGrant,
  redeemInviteLinkGrant,
  voucherSignaturesHold,
  type DirectAdmissionVoucher,
} from './graineAdmission';

/**
 * The admission proof's encodings (channel-encryption section 25): what a device signs, what the
 * server stores, and what an invite link's fragment carries. The rows that matter are the ones a
 * forger would try - a voucher moved to another person or community, a signature from another key.
 */

const DEVICE_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 10 + i);
const OTHER_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 90 + i);
const signer = { userId: 'carol', deviceId: 'dev-c' };
const place = { keyGroupId: 'kg-1', epoch: 7 };
let DEVICE_PK: Uint8Array;

beforeAll(async () => {
  DEVICE_PK = await ed25519PublicKeyOf(DEVICE_SECRET);
});

async function direct(
  overrides: Partial<DirectAdmissionVoucher> = {}
): Promise<DirectAdmissionVoucher> {
  const statement = {
    workspaceId: 'ws-1',
    subjectUserId: 'newcomer',
    signer,
    place,
    issuedAt: 1_800_000_000_000,
  };
  return {
    kind: 'direct',
    ...statement,
    signature: await webCryptoEngine.signWithSessionKey(
      DEVICE_SECRET,
      encodeDirectAdmission(statement)
    ),
    ...overrides,
  };
}

async function linkGrant() {
  return mintInviteLinkGrant(
    'ws-1',
    signer,
    place,
    1_800_000_000_000,
    1_900_000_000_000,
    webCryptoEngine,
    (m) => webCryptoEngine.signWithSessionKey(DEVICE_SECRET, m)
  );
}

describe('the statements a device signs', () => {
  it('begin with a zero byte, so a device signature over them is never an MLS SignContent', () => {
    for (const bytes of [
      encodeDirectAdmission({ workspaceId: 'w', subjectUserId: 's', signer, place, issuedAt: 0 }),
      encodeLinkAdmission({
        workspaceId: 'w',
        signer,
        place,
        issuedAt: 0,
        expiresAt: 0,
        linkPublicKey: new Uint8Array(32),
      }),
      encodeLinkRedemption('w', 's', new Uint8Array(32)),
    ]) {
      expect(bytes[0]).toBe(0);
    }
  });

  it('never collide across kinds, even over the same fields', () => {
    const direct = encodeDirectAdmission({
      workspaceId: 'w',
      subjectUserId: 's',
      signer,
      place,
      issuedAt: 0,
    });
    const redeem = encodeLinkRedemption('w', 's', new Uint8Array(32));
    expect(direct).not.toEqual(redeem);
  });
});

describe('a direct voucher', () => {
  it('round-trips through the stored form and verifies under its signer key', async () => {
    const voucher = await direct();
    const back = decodeAdmissionVoucher(encodeAdmissionVoucher(voucher));
    expect(back).toEqual(voucher);
    expect(await voucherSignaturesHold(back, DEVICE_PK, webCryptoEngine)).toBe(true);
  });

  it('does not verify once moved to another person or community', async () => {
    const voucher = await direct();
    expect(
      await voucherSignaturesHold({ ...voucher, subjectUserId: 'dave' }, DEVICE_PK, webCryptoEngine)
    ).toBe(false);
    expect(
      await voucherSignaturesHold({ ...voucher, workspaceId: 'ws-2' }, DEVICE_PK, webCryptoEngine)
    ).toBe(false);
  });

  it('does not verify once moved to another place in the history (a later epoch, another group)', async () => {
    const voucher = await direct();
    for (const moved of [
      { ...place, epoch: 8 },
      { ...place, keyGroupId: 'kg-2' },
    ]) {
      expect(
        await voucherSignaturesHold({ ...voucher, place: moved }, DEVICE_PK, webCryptoEngine)
      ).toBe(false);
    }
  });

  it('does not verify under another device key', async () => {
    const other = await ed25519PublicKeyOf(OTHER_SECRET);
    expect(await voucherSignaturesHold(await direct(), other, webCryptoEngine)).toBe(false);
  });

  it('refuses a malformed stored form with a typed error', () => {
    for (const bad of ['', 'not base64!', 'AAAA', encodeAdmissionVoucherTruncated()]) {
      expect(() => decodeAdmissionVoucher(bad)).toThrow(AdmissionFormatError);
    }
  });
});

/** A valid-looking prefix of a stored voucher: the label, then nothing. */
function encodeAdmissionVoucherTruncated(): string {
  return 'AAAAGmNhbmFyaS1ncmFpbmUtYWRtaXNzaW9uLXYx';
}

describe('a link voucher', () => {
  it('is built by the newcomer from the fragment and verifies with no secret', async () => {
    const grant = decodeInviteLinkGrant(encodeInviteLinkGrant(await linkGrant()));
    const voucher = await redeemInviteLinkGrant(grant, 'newcomer', webCryptoEngine);
    const stored = encodeAdmissionVoucher(voucher);

    // The stored form carries no secret: the server holds it and must not be able to mint more.
    expect(stored).not.toContain(encodeInviteLinkGrant(grant).slice(-40));
    const back = decodeAdmissionVoucher(stored);
    expect(await voucherSignaturesHold(back, DEVICE_PK, webCryptoEngine)).toBe(true);
  });

  it('carries its expiry through the fragment and the voucher, and does not verify once extended', async () => {
    const grant = decodeInviteLinkGrant(encodeInviteLinkGrant(await linkGrant()));
    expect(grant.expiresAt).toBe(1_900_000_000_000);
    const voucher = decodeAdmissionVoucher(
      encodeAdmissionVoucher(await redeemInviteLinkGrant(grant, 'newcomer', webCryptoEngine))
    );
    expect(voucher.kind === 'link' && voucher.expiresAt).toBe(1_900_000_000_000);
    expect(
      await voucherSignaturesHold(
        { ...voucher, expiresAt: 2_000_000_000_000 } as typeof voucher,
        DEVICE_PK,
        webCryptoEngine
      )
    ).toBe(false);
  });

  it('does not verify once moved to another person or another place', async () => {
    const voucher = await redeemInviteLinkGrant(await linkGrant(), 'newcomer', webCryptoEngine);
    expect(
      await voucherSignaturesHold({ ...voucher, subjectUserId: 'dave' }, DEVICE_PK, webCryptoEngine)
    ).toBe(false);
    expect(
      await voucherSignaturesHold(
        { ...voucher, place: { ...place, epoch: 99 } },
        DEVICE_PK,
        webCryptoEngine
      )
    ).toBe(false);
  });

  it('does not verify when the link key is not one the signer stood behind', async () => {
    const real = await linkGrant();
    const forged = await mintInviteLinkGrant(
      'ws-1',
      signer,
      place,
      1,
      1_900_000_000_000,
      webCryptoEngine,
      (m) => webCryptoEngine.signWithSessionKey(OTHER_SECRET, m)
    );
    // A forger's own link key, under the real link's device signature.
    const voucher = await redeemInviteLinkGrant(
      { ...forged, linkSignature: real.linkSignature },
      'newcomer',
      webCryptoEngine
    );
    expect(await voucherSignaturesHold(voucher, DEVICE_PK, webCryptoEngine)).toBe(false);
  });

  it('reads a fragment with or without its leading #, and refuses a damaged one', async () => {
    const fragment = encodeInviteLinkGrant(await linkGrant());
    expect(decodeInviteLinkGrant(`#${fragment}`).workspaceId).toBe('ws-1');
    expect(() => decodeInviteLinkGrant(fragment.slice(0, -4))).toThrow(AdmissionFormatError);
  });
});
