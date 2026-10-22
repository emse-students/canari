/**
 * The two halves of an MLS credential identity, `userId:deviceId` - minted in exactly one place
 * (`mls-core/src/state.rs`) and parsed here, and only here.
 *
 * AN IDENTITY CARRIES AT MOST ONE COLON, and one with more is REFUSED: both halves read as `''`,
 * which names no user and no device, so no comparison can match it. The ids come from the server
 * and from credentials, and a second colon would let `a:b:c` read as user `a` with device `b:c`
 * here while another reader split it elsewhere. Rust refuses the same shape where it binds a
 * KeyPackage to its device (`device_trust::is_well_formed_identity`).
 */

/** Identities already reported as malformed this session, so each is said once. */
const reportedMalformed = new Set<string>();

/** Whether `identity` holds more than one colon - and says so, once per identity. */
function isMalformed(identity: string): boolean {
  if (identity.indexOf(':') === identity.lastIndexOf(':')) return false;
  if (!reportedMalformed.has(identity)) {
    reportedMalformed.add(identity);
    console.error(
      `[IDENTITY] refused a leaf identity with more than one ':' (${identity.length} chars) - it names nobody`
    );
  }
  return true;
}

/** The user id half of a leaf identity, lower-cased; `''` for a refused identity. */
export function userIdOfLeaf(identity: string): string {
  if (isMalformed(identity)) return '';
  const colon = identity.indexOf(':');
  return (colon === -1 ? identity : identity.slice(0, colon)).toLowerCase();
}

/** The device id half of a leaf identity, or `''` when it carries none or is refused. */
export function deviceIdOfLeaf(identity: string): string {
  if (isMalformed(identity)) return '';
  const colon = identity.indexOf(':');
  return colon === -1 ? '' : identity.slice(colon + 1);
}
