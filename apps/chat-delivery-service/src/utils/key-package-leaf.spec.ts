import { createPublicKey, verify } from 'crypto';
import { readKeyPackageLeaf } from './key-package-leaf';

import {
  ALICE_KEY_PACKAGE as KEY_PACKAGE,
  ALICE_PROBE_SIGNATURE as PROBE_SIGNATURE,
} from '../testing/keyPackageFixture';

/** A raw 32-byte Ed25519 key as a Node KeyObject, via its fixed SPKI prefix (RFC 8410). */
function ed25519(raw: Buffer) {
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

describe('readKeyPackageLeaf', () => {
  it('reads the identity and the key the device signs with', () => {
    const leaf = readKeyPackageLeaf(KEY_PACKAGE);
    expect(leaf?.identity).toBe('alice-user:dev-a1');
    const key = Buffer.from(leaf!.signatureKey, 'base64');
    expect(key).toHaveLength(32);
    const signed = verify(
      null,
      Buffer.from('probe'),
      ed25519(key),
      Buffer.from(PROBE_SIGNATURE, 'base64')
    );
    expect(signed).toBe(true);
  });

  it('refuses bytes that are not an MLS 1.0 KeyPackage', () => {
    const bytes = Buffer.from(KEY_PACKAGE, 'base64');
    const wrongVersion = Buffer.from(bytes);
    wrongVersion.writeUInt16BE(2, 0);
    expect(readKeyPackageLeaf(wrongVersion.toString('base64'))).toBeNull();
    expect(readKeyPackageLeaf('')).toBeNull();
  });

  it('refuses a truncated package rather than reading past its end', () => {
    const bytes = Buffer.from(KEY_PACKAGE, 'base64');
    // Cut inside the identity: the credential is announced and never delivered.
    expect(readKeyPackageLeaf(bytes.subarray(0, 120).toString('base64'))).toBeNull();
    expect(readKeyPackageLeaf(bytes.subarray(0, 40).toString('base64'))).toBeNull();
  });

  it('refuses a credential that is not basic', () => {
    const bytes = Buffer.from(KEY_PACKAGE, 'base64');
    const x509 = Buffer.from(bytes);
    // version, suite, init_key (1+32), encryption_key (1+32), signature_key (1+32): 103 bytes in.
    expect(x509.readUInt16BE(103)).toBe(1);
    x509.writeUInt16BE(2, 103);
    expect(readKeyPackageLeaf(x509.toString('base64'))).toBeNull();
  });
});
