/**
 * What an external commit built on a served GroupInfo would bring into the group, read off that
 * GroupInfo's tree by the engine (`MlsManager::external_join_standing` in `mls-core/src/welcome.rs`):
 *
 * - `own-leaf`: the tree holds THIS device's own leaf - the commit replaces it;
 * - `further-device`: a leaf of this device's user and none of its own - a further device of a
 *   member, whose door is a member's Add (`further_device`, `requestReAdd`);
 * - `no-leaf-of-user`: no leaf of this device's user - the entry no member made, which every
 *   member's admission verdict names `Uninvited` and reports as `[UNINVITED_ENTRY]`.
 *
 * THE JOINER'S OWN STATEMENT OF THE CLASS ITS MEMBERS WILL JUDGE, taken before it builds - the
 * discriminator the admission fix-forward needs at the throw (slice 1,
 * `docs/wiki/protocols/admission-fix-forward.md`).
 */
export type ExternalJoinStanding = 'own-leaf' | 'further-device' | 'no-leaf-of-user';

const STANDINGS: readonly ExternalJoinStanding[] = [
  'own-leaf',
  'further-device',
  'no-leaf-of-user',
];

/**
 * The engine's answer as a type. Anything else is a binding that does not match this client - a
 * stale WASM or native build - and THROWS: the caller already reads a throw as "the served tree
 * could not be read" and builds nothing, which is the only safe answer to a word it does not know.
 */
export function parseExternalJoinStanding(word: unknown): ExternalJoinStanding {
  if (typeof word === 'string' && (STANDINGS as readonly string[]).includes(word)) {
    return word as ExternalJoinStanding;
  }
  throw new Error(`unknown external-join standing from the engine: ${String(word).slice(0, 40)}`);
}
