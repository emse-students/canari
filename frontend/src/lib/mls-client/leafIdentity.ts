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

/**
 * A user id in its canonical form: ASCII letters lowercased, nothing else touched - exactly Rust's
 * `to_ascii_lowercase`, so a non-ASCII id compares the same on both sides. Every comparison of a
 * user id against a leaf's user half goes through it.
 */
export function canonicalUserId(userId: string): string {
  return userId.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * THE ONE CANONICAL FORM OF A DEVICE IDENTITY, the TypeScript twin of Rust's
 * `device_trust::canonical_identity` (which keys the pins and binds every KeyPackage): the user half
 * through {@link canonicalUserId}, the device half exact. `null` for anything but one colon between
 * two non-empty halves - such an identity names no device, so it equals nothing.
 *
 * Every TypeScript comparison of two device identities uses it (or {@link sameDeviceIdentity} /
 * {@link treeHoldsDevice}): a spelling Rust takes for a pinned device must never read here as
 * another device, or the caller falls through to an Add Rust then refuses.
 */
export function canonicalIdentity(identity: string): string | null {
  if (isMalformed(identity)) return null;
  const colon = identity.indexOf(':');
  if (colon <= 0 || colon === identity.length - 1) return null;
  return `${canonicalUserId(identity.slice(0, colon))}:${identity.slice(colon + 1)}`;
}

/** Whether two identities name the same device under {@link canonicalIdentity}. */
export function sameDeviceIdentity(a: string, b: string): boolean {
  const ca = canonicalIdentity(a);
  return ca !== null && ca === canonicalIdentity(b);
}

/** Whether `leafIdentities` (a tree, `getGroupMemberIdentities`) holds the device `userId:deviceId`. */
export function treeHoldsDevice(
  leafIdentities: readonly string[],
  userId: string,
  deviceId: string
): boolean {
  const wanted = canonicalIdentity(`${userId}:${deviceId}`);
  return wanted !== null && leafIdentities.some((leaf) => canonicalIdentity(leaf) === wanted);
}

/**
 * Whether `leafIdentities` (a tree, `getGroupMemberIdentities`) holds ANY leaf of `userId` - the
 * question an automatic Add asks before it brings a device in: a device of a user already in the
 * tree is a member's device, one of a user absent from it is a new person, whom only a member's own
 * gesture admits. A legacy bare leaf names its user ({@link canonicalUserOf}), so it counts.
 */
export function treeHoldsUser(leafIdentities: readonly string[], userId: string): boolean {
  const wanted = canonicalUserId(userId);
  return wanted !== '' && leafIdentities.some((leaf) => canonicalUserOf(leaf) === wanted);
}

/**
 * The user a leaf identity names, canonical ({@link canonicalUserId}), or `null` when it names
 * nobody - the twin of Rust's `device_trust::canonical_user_of`.
 *
 * TWO SHAPES ARE READ: a device identity `user:device` ({@link canonicalIdentity}), and the LEGACY
 * BARE `user` credential builds before device identities wrote (no colon). A bare leaf names its user
 * and NO device: {@link canonicalIdentity} refuses it, so it never matches `user:device`. Kept until
 * no held tree carries a bare leaf (docs/wiki/legacy-compatibility.md).
 */
export function canonicalUserOf(identity: string): string | null {
  if (identity !== '' && !identity.includes(':')) return canonicalUserId(identity);
  const canonical = canonicalIdentity(identity);
  return canonical === null ? null : canonical.slice(0, canonical.indexOf(':'));
}

/** The user id of a leaf identity ({@link canonicalUserOf}); `''` for one that names nobody. */
export function userIdOfLeaf(identity: string): string {
  return canonicalUserOf(identity) ?? '';
}

/** The device id half of a leaf identity, or `''` when it carries none or is refused. */
export function deviceIdOfLeaf(identity: string): string {
  if (isMalformed(identity)) return '';
  const colon = identity.indexOf(':');
  return colon === -1 ? '' : identity.slice(colon + 1);
}
