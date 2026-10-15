import {
  graineSeedCommitment,
  GraineSignatureError,
  verifyGraineEndorsementV2,
} from '$lib/crypto/graineV2';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { IncomingSeed } from './wireSeed';

/**
 * What checking a v2 seed's endorsement established.
 *
 * - `valid`: the minter's device signed this session key AND this seed. `source` says which key
 *   proved it: the key group's `tree`, or the keys the `server` published for a device that has left
 *   it - the weaker trust, which the caller reports.
 * - `refused`: it did not - a forged minter, a substituted key or seed, or a v2 seed missing its
 *   fields. Never stored, not even half.
 * - `unanswered`: the minter's device has left the tree and the server could not be asked. This
 *   says nothing about the seed, so it is not stored NOW and stays re-askable: a later row under the
 *   session is a missing seed, which repairs.
 */
export type EndorsementVerdict =
  | { kind: 'valid'; source: EndorsementSource }
  | { kind: 'refused'; why: string }
  | { kind: 'unanswered'; why: string };

/** Which key proved a valid endorsement: the key group's tree, or the server's published keys. */
export type EndorsementSource = 'tree' | 'server';

/**
 * Checks a v2 seed's endorsement against the minter device's signature key (channel-encryption
 * section 21): the key the key group's TREE holds for that device when it is still a member - the
 * key every member already agreed on - and otherwise the keys the server published for it, which is
 * the trust a BasicCredential already gives the server and no more (decided by the user).
 *
 * The tree is not a first try with the server behind it: when the device IS in the tree, its leaf
 * key is the only one asked, and a failure there is a refusal.
 *
 * @param keyGroupId The distribution group the seed arrived on, whose tree names the minter.
 */
export async function checkSeedEndorsement(
  mls: IMlsService,
  keyGroupId: string,
  seed: IncomingSeed
): Promise<EndorsementVerdict> {
  const v2 = seed.v2;
  // A v1 seed names no minter, so nothing can endorse it: its caller refuses it before asking.
  if (!v2) return { kind: 'refused', why: 'a v1 seed carries no endorsement' };
  if (
    !v2.minterUserId ||
    !v2.minterDeviceId ||
    v2.signingPublicKey.length === 0 ||
    v2.endorsement.length === 0
  ) {
    return { kind: 'refused', why: 'a v2 seed without its minter, key or endorsement' };
  }

  const identity = `${v2.minterUserId}:${v2.minterDeviceId}`;
  const treeKey = await mls.memberSignatureKey(keyGroupId, identity);
  let candidates: Uint8Array[];
  let source: EndorsementSource;
  if (treeKey) {
    candidates = [treeKey];
    source = 'tree';
  } else {
    const published = await mls.fetchDeviceSignatureKeys(v2.minterUserId, v2.minterDeviceId);
    if (published.kind === 'unanswered') {
      return {
        kind: 'unanswered',
        why: `${identity} has left the tree and its published keys are unreachable (${published.detail})`,
      };
    }
    candidates = published.keys;
    source = 'server';
  }
  if (candidates.length === 0) {
    return {
      kind: 'refused',
      why: `${identity} has no signature key in the tree or on the server`,
    };
  }

  const endorsement = {
    channelId: seed.channelId,
    sessionId: seed.sessionId,
    minterUserId: v2.minterUserId,
    minterDeviceId: v2.minterDeviceId,
    signingPublicKey: v2.signingPublicKey,
    seedCommitment: await graineSeedCommitment(seed.seed),
    createdAt: seed.createdAt,
  };
  const engine = mls.graineSignatureEngine();
  let last: unknown = null;
  for (const key of candidates) {
    try {
      await verifyGraineEndorsementV2(endorsement, seed.seed, v2.endorsement, key, engine);
      // NO LINE OF ITS OWN. A success here is a seed being stored, and the caller already says that
      // once per seed or once per bundle - with this source in it. A line per verification printed
      // 496 times in one sign-in on the Mi 9T (2026-10-13), the largest tag of the capture, and said
      // nothing the stored-seed line did not.
      return { kind: 'valid', source };
    } catch (err) {
      if (!(err instanceof GraineSignatureError)) throw err;
      last = err;
    }
  }
  return {
    kind: 'refused',
    why: `the endorsement does not verify against ${identity} from the ${source} (${candidates.length} key(s)): ${String(last)}`,
  };
}
