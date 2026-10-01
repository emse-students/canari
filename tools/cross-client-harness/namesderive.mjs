/**
 * THE DERIVATIONS OVER THE MACHINE-LOCAL VALUES - committed, so they are reviewable and testable.
 *
 * `names.mjs` is gitignored because it holds display names; the helpers that CHOOSE between those
 * names are logic, and logic out of tree is neither reviewed nor tested. So the split is: the local
 * file holds VALUES only (`DISPLAY_NAME_OF`, `ACCOUNT_OF`), and calls `makeNameHelpers` from here for
 * `OWNER_NAME`, `PEER_NAME`, `displayNameFor` and `peerNameFor`, re-exporting them under the same
 * specifier every check already imports.
 *
 * `peerNameFor` REFUSES rather than guesses: it used to be `device === 'W2' ? OWNER : PEER`, whose
 * false branch was "everything that is not W2", so a device held by a third account answered with a
 * real name of the wrong human and no error.
 */

/** The two accounts that form the campaign's DM pair, as keys of `test-accounts.json`. */
export const DEFAULT_PAIR = ['owner', 'peer'];

/**
 * Build the name helpers from the machine-local values.
 *
 * @param {{DISPLAY_NAME_OF: Record<string,string>, ACCOUNT_OF: Record<string,string>, PAIR?: [string,string]}} values
 */
export function makeNameHelpers({ DISPLAY_NAME_OF, ACCOUNT_OF, PAIR = DEFAULT_PAIR }) {
  const [ownerKey, peerKey] = PAIR;

  /** The display name of an account KEY, or a throw: an undefined name would click nothing. */
  const displayNameFor = (key) => {
    const name = DISPLAY_NAME_OF[key];
    if (typeof name !== 'string' || name === '') {
      throw new Error(`no display name for account '${key}' - known: ${Object.keys(DISPLAY_NAME_OF).join(' ')}`);
    }
    return name;
  };

  /**
   * The name a client must click to reach the shared DM: the OTHER party of the pair. A device whose
   * account is outside the pair has no defined counterpart, so it throws - call `displayNameFor`
   * with the account you mean instead.
   */
  const peerNameFor = (device) => {
    const key = ACCOUNT_OF[device];
    if (key === undefined) throw new Error(`peerNameFor: device '${device}' has no ACCOUNT_OF entry`);
    if (key === ownerKey) return displayNameFor(peerKey);
    if (key === peerKey) return displayNameFor(ownerKey);
    throw new Error(
      `peerNameFor: device '${device}' holds '${key}', outside the pair ${ownerKey}/${peerKey} - ` +
        `its counterpart is not defined; call displayNameFor(<account key>) for the one you mean`
    );
  };

  return {
    OWNER_NAME: displayNameFor(ownerKey),
    PEER_NAME: displayNameFor(peerKey),
    displayNameFor,
    peerNameFor,
  };
}
