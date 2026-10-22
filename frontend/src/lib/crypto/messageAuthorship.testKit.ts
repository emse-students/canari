/**
 * TEST-ONLY: authors that sign like mls-core does, for the tests of every relayed-proof check.
 * Ed25519 is deterministic, so a proof minted here is the proof mls-core would append for the same
 * key and bytes (`mls-core/tests/authored_frames.rs`).
 */
import { canari } from '$lib/proto/canari.js';
import { encodeAppMessage, type IAppMessage } from '$lib/proto/codec';
import { webCryptoEngine } from '$lib/crypto/graineV2.testEngine';
import { toBase64 } from '$lib/utils/hex';
import {
  authorDescriptor,
  type AuthorKeySource,
  type RecordedAuthorship,
} from '$lib/crypto/messageAuthorship';

/** One device that can sign: its identity and its key pair. */
export interface TestAuthor {
  identity: string;
  secret: Uint8Array;
  publicKey: Uint8Array;
}

export async function newTestAuthor(identity: string): Promise<TestAuthor> {
  const pair = await webCryptoEngine.newSessionKeyPair();
  return { identity, secret: pair.secret, publicKey: pair.publicKey };
}

/** The proof `author` would record for `message` in `groupId`, as a bundle carries it. */
export async function signedBy(
  author: TestAuthor,
  groupId: string,
  message: IAppMessage,
  opts: { claim?: string } = {}
): Promise<RecordedAuthorship> {
  const body = encodeAppMessage(message);
  const claim = opts.claim ?? author.identity;
  const signature = await webCryptoEngine.signWithSessionKey(
    author.secret,
    await authorDescriptor(groupId, claim, body)
  );
  const proof = canari.AuthorProof.encode(
    canari.AuthorProof.create({ version: 1, author: claim, signature })
  ).finish();
  return { body: toBase64(body), proof: toBase64(proof), group: groupId };
}

/** A key source answering from a fixed tree: a device not in `tree` has no trusted key. */
export function keySource(opts: { tree?: TestAuthor[] }): AuthorKeySource {
  return {
    async memberSignatureKey(_groupId, identity) {
      return opts.tree?.find((a) => a.identity === identity)?.publicKey ?? null;
    },
    graineSignatureEngine: () => webCryptoEngine,
  };
}
