/** Production web origin used for shareable links when the WebView runs on Tauri. */
export const DEFAULT_PUBLIC_APP_ORIGIN = 'https://canari-emse.fr';

/** Hostnames treated as in-app navigation targets (not external browser). */
export const PUBLIC_APP_HOSTS = ['canari-emse.fr', 'www.canari-emse.fr'] as const;

/** True when the WebView origin must not be used for outbound share links. */
function isNonPublicWebViewOrigin(origin: string): boolean {
  return /tauri\.localhost/i.test(origin);
}

/**
 * Canonical HTTPS origin for links shared outside the app (clipboard, Stripe, etc.).
 * Never returns `tauri.localhost` on mobile/desktop Tauri builds.
 */
export function publicAppOrigin(): string {
  const fromEnv = (import.meta.env.VITE_FRONTEND_URL as string | undefined)?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');

  if (typeof window !== 'undefined') {
    const origin = window.location.origin.replace(/\/$/, '');
    if (!isNonPublicWebViewOrigin(origin)) return origin;
  }

  return DEFAULT_PUBLIC_APP_ORIGIN;
}

/** Builds an absolute public URL for a SPA path (e.g. `/posts/abc`). */
export function publicAppUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${publicAppOrigin()}${normalized}`;
}

/** True when `url` points at the public Canari web app (not API-only hosts). */
export function isPublicAppUrl(url: string, base?: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const resolvedBase =
      base ??
      (typeof window !== 'undefined' ? window.location.href : `${DEFAULT_PUBLIC_APP_ORIGIN}/`);
    const u = new URL(trimmed, resolvedBase);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return (
      (PUBLIC_APP_HOSTS as readonly string[]).includes(u.hostname) ||
      u.hostname.endsWith('.canari-emse.fr')
    );
  } catch {
    return false;
  }
}

/**
 * Maps a public Canari URL to an in-app SvelteKit path, or null if unsupported.
 * Accepts legacy `/post/{id}` (singular) and redirects to `/posts/{id}`.
 */
export function inAppPathFromPublicUrl(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (!isPublicAppUrl(u.href)) return null;

    let path = u.pathname || '/';
    const legacyPost = path.match(/^\/post\/([^/]+)\/?$/);
    if (legacyPost) path = `/posts/${legacyPost[1]}`;

    if (
      /^\/(posts|forms|associations|profile|chat|shop|calendar|communities|notifications)(\/|$)/.test(
        path
      ) ||
      path === '/'
    ) {
      return `${path}${u.search}${u.hash}`;
    }
    return null;
  } catch {
    return null;
  }
}
