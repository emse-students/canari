/**
 * THE HANDOFF LANDING PAGE'S LOGIC - step 1 of the redemption contract every MiConnect site
 * implements (Canari's docs/wiki/backlog.d/sign-in-handoff-to-the-ecosystem-sites-and-migallery-notifications.md,
 * section 8). The site's `/auth/handoff` page draws the interstitial and builds its own login URL;
 * everything else is here, so it is the same on every site.
 *
 * VENDORED BYTE-IDENTICALLY, like `handoff-verify.ts`: the source is Canari's
 * `libs/handoff/handoff-landing.ts`, and `tools/ecosystem-shape/shape.mjs` fails when a GitHub copy
 * differs. No dependency, no third-party script, browser globals passed in so it is testable.
 */

/** The redemption route, on the site's own origin. */
export const HANDOFF_REDEEM_PATH = '/api/auth/handoff';

/**
 * Reads the token from the fragment and REMOVES it from the address bar at once, before anything
 * else runs: a reload, the back button or a copied address then carries no token. `''` when the
 * fragment is empty.
 */
export function takeHandoffToken(
  location: Pick<Location, 'hash' | 'pathname'>,
  history: Pick<History, 'replaceState'>
): string {
  const token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  return token;
}

/** Who the interstitial names: the session already open (if any) and the one the token opens. */
export interface HandoffInterstitial {
  current: string | null;
  next: { name: string; photo: string | null };
}

/** What the page does next. `login` is the site's ordinary OIDC login, with `redirectTo` when set. */
export type LandingStep =
  | { kind: 'go'; to: string }
  | { kind: 'confirm'; interstitial: HandoffInterstitial }
  | { kind: 'login'; redirectTo: string | null };

/**
 * POSTs the token (and, after the user's click, `confirm: true`) to the redemption route and says
 * what to do with the answer. Same origin, JSON, the token in the body only. Any answer outside the
 * contract - a 4xx, a 5xx, no answer, a malformed body - is the ordinary login without `redirectTo`.
 */
export async function redeemHandoff(
  token: string,
  confirm: boolean,
  fetchFn: typeof fetch = fetch
): Promise<LandingStep> {
  if (!token) return { kind: 'login', redirectTo: null };
  let body: unknown;
  try {
    const res = await fetchFn(HANDOFF_REDEEM_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(confirm ? { token, confirm: true } : { token }),
    });
    if (!res.ok) return { kind: 'login', redirectTo: null };
    body = await res.json();
  } catch {
    return { kind: 'login', redirectTo: null };
  }
  return stepOf(body);
}

/** The contract's 200 answers, read defensively. */
export function stepOf(body: unknown): LandingStep {
  const b = (body ?? {}) as Record<string, unknown>;
  const dest = typeof b.dest === 'string' && isLocalPath(b.dest) ? b.dest : null;
  if (b.outcome === 'ok' && dest) return { kind: 'go', to: dest };
  if (b.outcome === 'unknown_user' && dest) return { kind: 'login', redirectTo: dest };
  if (b.outcome === 'confirm') {
    const next = (b.next ?? {}) as Record<string, unknown>;
    if (typeof next.name === 'string') {
      return {
        kind: 'confirm',
        interstitial: {
          current: typeof b.current === 'string' ? b.current : null,
          next: { name: next.name, photo: typeof next.photo === 'string' ? next.photo : null },
        },
      };
    }
  }
  return { kind: 'login', redirectTo: null };
}

/** A path on this origin: one leading slash, no scheme, no host, no backslash. */
function isLocalPath(p: string): boolean {
  return p.startsWith('/') && !p.startsWith('//') && !p.includes('\\');
}
