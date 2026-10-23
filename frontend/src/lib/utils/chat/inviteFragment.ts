/**
 * AN INVITE LINK'S FRAGMENT, carried across the sign-in that may stand between opening the link and
 * joining (channel-encryption section 25).
 *
 * The fragment is the admission proof's grant: whoever holds it can prove an admission, so it lives
 * only after the `#`, which a browser never sends to a server. A newcomer who is not signed in is
 * sent to the login page and back by path, and the path does not carry it - so it waits in THIS
 * TAB's session storage, bound to the link's token, and is taken back exactly once. Never put in the
 * `returnTo` parameter: that one travels through the identity provider.
 *
 * Not per account: it is held before any account is known, for one tab, and removed on first read.
 */

const PENDING_INVITE_FRAGMENT_KEY = 'canari.pending-invite-fragment';

/**
 * The fragment for the link `token`: the one in the address bar when there is one, otherwise the one
 * kept for this token across a sign-in, taken (removed) as it is read. The caller clears the address
 * (`dropAddressFragment`), so a copied or bookmarked address does not carry the secret along.
 *
 * @param hash `window.location.hash`, with or without its `#`.
 * @returns the fragment, or `''` for a link that carried none.
 */
export function takeInviteFragment(token: string, hash: string): string {
  const inAddress = hash.replace(/^#/, '');
  const kept = takeKept(token);
  return inAddress || kept;
}

/** Keeps `fragment` for the link `token` across a sign-in in this tab. Nothing to keep is a no-op. */
export function keepInviteFragment(token: string, fragment: string): void {
  if (!fragment) return;
  try {
    sessionStorage.setItem(PENDING_INVITE_FRAGMENT_KEY, JSON.stringify({ token, fragment }));
  } catch (e) {
    // Said, not hidden: the newcomer then joins with no past, and a newer link gives them one.
    console.warn(
      `[INVITE] the link's admission proof could not be kept across sign-in: ${String(e)}`
    );
  }
}

/** The fragment kept for `token`, removed as it is read; any other token's is dropped too. */
function takeKept(token: string): string {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(PENDING_INVITE_FRAGMENT_KEY);
    sessionStorage.removeItem(PENDING_INVITE_FRAGMENT_KEY);
  } catch (e) {
    console.warn(`[INVITE] the kept admission proof could not be read: ${String(e)}`);
    return '';
  }
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { token?: unknown; fragment?: unknown };
    if (parsed.token === token && typeof parsed.fragment === 'string') return parsed.fragment;
    console.info('[INVITE] a kept admission proof named another link - dropped');
  } catch (e) {
    console.warn(`[INVITE] the kept admission proof is not valid JSON - dropped: ${String(e)}`);
  }
  return '';
}
