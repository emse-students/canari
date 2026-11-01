import { resolve } from '$app/paths';
import type { PathnameWithSearchOrHash } from '$app/types';

/**
 * An app path (base-less, leading `/`) whose SHAPE the compiler has matched against the route
 * table: `/posts/${string}` is one, `/no-such-page` is not. A producer that builds its destination
 * from code - a notification's, a deep link's - returns this, so a route renamed or deleted under
 * it fails `bun run check` instead of a tap at runtime. SvelteKit 3's `goto` REJECTS a URL that
 * matches no route (`navigation_route_missing`), where 2 navigated natively; a path of unknown
 * origin, which no type can vouch for, goes through `gotoAppPath` instead.
 */
export type AppPath = `/${PathnameWithSearchOrHash}`;

/** The one backslash, spelt by code point: a literal one in a string or template is an escape. */
const BACKSLASH = String.fromCharCode(92);

/**
 * Types a path COMPUTED AT RUNTIME as one of this app's own, so it can go through `resolve()`.
 *
 * Every navigation is written `goto(resolve(...))` / `href={resolve(...)}` (the oxvelte rule
 * `svelte/no-navigation-without-resolve` is on), which is what makes the app survive being served
 * under a base path: `resolve` prefixes `base`. A literal route type-checks against the route table
 * by itself; a path that arrives as a `string` - a `returnTo`, a deep link, a tab's target - cannot,
 * and this is the ONE place that asserts it.
 *
 * THE CONVENTION: an "app path" is BASE-LESS (`/forms/3`), and `resolve` is the only thing that adds
 * the base. A producer that reads `location.pathname` / `url.pathname` (which include the base) must
 * go through `appPathFromPathname` first, or `resolve` would prefix the base a second time.
 *
 * WHY THE TYPE IS `''` AND THE LEADING SLASH IS DROPPED (SvelteKit 3): `resolve` reads a string that starts
 * with `/` as a ROUTE ID - it strips `(groups)` and demands parameters for every `[segment]` - and
 * anything else as a plain PATHNAME. A computed path is a pathname, so it must go in the second
 * form, or a value carrying a `[` would throw. `resolve`'s parameter type is a union over every
 * route, which no single union-typed value satisfies, so the assertion names one member - the root
 * `''`, which has no parameters. It asserts and does not check: a value of unknown origin goes
 * through `safeInternalPath` first.
 */
export function internalPath(path: string): '' {
  return (path.startsWith('/') ? path.slice(1) : path) as '';
}

/**
 * The origin a candidate path is resolved against to learn where a browser would send it. Reserved
 * (`.invalid`, RFC 2606), so no real page can ever share it.
 */
const PROBE_ORIGIN = 'https://internal-path.invalid';

/**
 * Whether `value` holds, at any position, a control character - C0 (below U+0020), DEL (U+007F) or
 * C1 (U+0080-U+009F) - a line or paragraph separator (U+2028, U+2029), or a backslash. None belongs
 * in an in-app path written by this app, which percent-encodes anything of the kind.
 */
function hasControlOrBackslash(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true;
    }
    if (value[i] === BACKSLASH) return true;
  }
  return false;
}

/**
 * Validates a path of UNKNOWN origin (a query parameter, a stored value) as an in-app path.
 *
 * Returns it when it is a string that starts with `/`, carries no control character, line separator
 * or backslash anywhere, and - resolved against a fixed reserved origin (`PROBE_ORIGIN`) - keeps
 * that origin; `fallback` otherwise, a non-string value included. For a value starting with `/`,
 * keeping the probe's origin is keeping the page's: the result is relative to whatever origin it
 * is resolved against. The verdict is the URL parser's own, not a reading of the first characters:
 * what decides where a link goes is how a browser parses it, so that is what is asked. Decided
 * here, at the source, as a value: `resolve` would otherwise THROW on a non-absolute path, and every
 * consumer (a `goto`, an `href`, a stored sign-in return) receives a value already held to the
 * page's origin.
 */
export function safeInternalPath(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (typeof raw !== 'string') {
    console.warn(`[nav] safeInternalPath refused a target that is not a string (${typeof raw})`);
    return fallback;
  }
  if (!raw.startsWith('/') || hasControlOrBackslash(raw)) {
    console.warn(
      `[nav] safeInternalPath refused a target (length ${raw.length}) - not an in-app path`
    );
    return fallback;
  }
  let resolved: URL;
  try {
    resolved = new URL(raw, `${PROBE_ORIGIN}/`);
  } catch (err) {
    // The error's name only: a parser message may quote the value, and the value is not logged.
    console.warn(
      `[nav] safeInternalPath refused a target the URL parser rejects (${(err as Error).name})`
    );
    return fallback;
  }
  if (resolved.origin !== PROBE_ORIGIN) {
    console.warn(
      `[nav] safeInternalPath refused a target (length ${raw.length}) - it leaves the origin`
    );
    return fallback;
  }
  return raw;
}

/**
 * Turns a browser pathname (base included) into a base-less app path, the form `returnTo` carries
 * and `resolve` expects. At `base === ''` it is the identity.
 */
export function appPathFromPathname(pathname: string): string {
  // `$app/paths` no longer exports `base`; `resolve('')` is the base and a closing slash.
  const base = resolve('').replace(/\/$/, '');
  if (base && (pathname === base || pathname.startsWith(`${base}/`))) {
    return pathname.slice(base.length) || '/';
  }
  return pathname;
}

/**
 * The login URL (base-less, ready for `resolve`) that brings the user back to the page they are on.
 *
 * The one producer of `returnTo` from a browser location: it strips the base the pathname carries,
 * so that the consumer's `resolve(internalPath(returnTo))` adds it exactly once.
 */
export function loginReturningTo(pathname: string, search: string, hash: string): string {
  return `/login?returnTo=${encodeURIComponent(appPathFromPathname(pathname) + search + hash)}`;
}

/**
 * Whether a base-less app path is one a signed-out visitor may stand on: the sign-in flow, the
 * legal pages and a public form's guest page (`/f/`). The root layout's guard skips them, and the
 * login redirect must never carry one as its `returnTo` (it would bounce back to itself).
 */
export function isSignedOutPath(path: string): boolean {
  return (
    path.startsWith('/login') ||
    path.startsWith('/auth') ||
    path.startsWith('/legal') ||
    path.startsWith('/f/')
  );
}

/**
 * Where a DEAD session sends the user: `/login`, carrying the page the user was going to.
 *
 * `target` is the page being navigated TO when a navigation is in flight (a tapped notification
 * publishes its route with `goto`, and the layout's `load` is what discovers the 401), otherwise the
 * page shown. Reading only the page shown lost a post push tapped from a killed app whose session
 * was gone: the refresh answered 401 while the deep link's navigation was still pending, the handler
 * went to a bare `/login`, and the target was dropped (Mi 9T, 2026-10-08). The root and the sign-in
 * pages have nothing worth returning to, so they stay bare.
 */
export function loginAfterSessionExpiry(
  target: { pathname: string; search: string; hash: string } | null | undefined
): string {
  if (!target) return '/login';
  const path = appPathFromPathname(target.pathname);
  if (path === '/' || isSignedOutPath(path)) return '/login';
  return loginReturningTo(target.pathname, target.search, target.hash);
}
