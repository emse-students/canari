import { readMlsOpaque } from './mls-tls';

/**
 * What a published KeyPackage says about the device that minted it, read from its CLEAR bytes.
 *
 * `signatureKey` is the device's MLS signature public key - the key that signs its commits and,
 * since Graine v2, the endorsement of every seed it mints (channel-encryption section 21).
 * `identity` is the BasicCredential identity, `userId:deviceId` by construction of the client.
 */
export interface KeyPackageLeaf {
  /** The raw Ed25519 public key, base64 (32 bytes, 44 characters). */
  signatureKey: string;
  identity: string;
}

/** RFC 9420 `ProtocolVersion.mls10`. */
const MLS10 = 1;
/** RFC 9420 `CredentialType.basic` - the only credential this estate mints. */
const CREDENTIAL_BASIC = 1;

/**
 * Reads the signature key and the credential identity out of a serialized KeyPackage.
 *
 * RFC 9420 section 10: `version (u16) || cipher_suite (u16) || init_key<V> || leaf_node`, and a
 * `LeafNode` begins `encryption_key<V> || signature_key<V> || credential`, where a BasicCredential
 * is `credential_type (u16) || identity<V>`. Everything this reads is public - the same bytes any
 * member fetches to add the device - and NOTHING HERE VERIFIES THE PACKAGE'S OWN SIGNATURE: the
 * server records what a device PUBLISHED, which is exactly the trust a BasicCredential already asks
 * of it (section 7), and the caller checks that the identity names the uploader.
 *
 * @returns the leaf, or null for bytes that are not an MLS 1.0 KeyPackage with a basic credential.
 *   Null is an answer, and the caller logs it rather than recording a key it could not read.
 */
export function readKeyPackageLeaf(keyPackageBase64: string): KeyPackageLeaf | null {
  const bytes = Buffer.from(keyPackageBase64, 'base64');
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== MLS10) return null;

  const initKey = readMlsOpaque(bytes, 4);
  if (!initKey) return null;
  const encryptionKey = readMlsOpaque(bytes, initKey.next);
  if (!encryptionKey) return null;
  const signatureKey = readMlsOpaque(bytes, encryptionKey.next);
  if (!signatureKey || signatureKey.bytes.length === 0) return null;

  const credentialAt = signatureKey.next;
  if (bytes.length < credentialAt + 2) return null;
  if (bytes.readUInt16BE(credentialAt) !== CREDENTIAL_BASIC) return null;
  const identity = readMlsOpaque(bytes, credentialAt + 2);
  if (!identity) return null;

  return {
    signatureKey: signatureKey.bytes.toString('base64'),
    identity: identity.bytes.toString('utf8'),
  };
}
