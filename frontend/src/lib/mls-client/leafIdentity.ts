/**
 * The two halves of an MLS credential identity, `userId:deviceId` - minted in exactly one place
 * (`mls-core/src/state.rs`) and parsed here, and only here.
 *
 * Split on the FIRST colon: a device id may contain one (`web-<user>-<rand>-<rand>` does not, but
 * nothing in the credential format forbids it), and a user id never does.
 */

/** The user id half of a leaf identity, lower-cased. */
export function userIdOfLeaf(identity: string): string {
  const colon = identity.indexOf(':');
  return (colon === -1 ? identity : identity.slice(0, colon)).toLowerCase();
}

/** The device id half of a leaf identity, or `''` when it carries none. */
export function deviceIdOfLeaf(identity: string): string {
  const colon = identity.indexOf(':');
  return colon === -1 ? '' : identity.slice(colon + 1);
}
