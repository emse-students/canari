/** Production web origin used for shareable links when the WebView runs on Tauri. */
export const DEFAULT_PUBLIC_APP_ORIGIN = 'https://canari-emse.fr';

/** Hostnames treated as in-app navigation targets (not external browser). */
export const PUBLIC_APP_HOSTS = ['canari-emse.fr', 'www.canari-emse.fr'] as const;

/** SPA path prefixes that open inside the app (not the system browser). */
export const IN_APP_ROUTE_RE =
  /^\/(posts|forms|associations|profile|chat|shop|calendar|communities|notifications)(\/|$)/;

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
 * Normalizes a pathname (legacy `/post/{id}` → `/posts/{id}`) and returns the in-app path
 * with query/hash when the route is supported, otherwise null.
 */
export function normalizeInAppPathname(pathname: string, search = '', hash = ''): string | null {
  let path = pathname || '/';
  const legacyPost = path.match(/^\/post\/([^/]+)\/?$/);
  if (legacyPost) path = `/posts/${legacyPost[1]}`;

  if (IN_APP_ROUTE_RE.test(path) || path === '/') {
    return `${path}${search}${hash}`;
  }
  return null;
}

/**
 * Maps a public Canari URL to an in-app SvelteKit path, or null if unsupported.
 * Accepts legacy `/post/{id}` (singular) and redirects to `/posts/{id}`.
 */
export function inAppPathFromPublicUrl(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (!isPublicAppUrl(u.href)) return null;
    return normalizeInAppPathname(u.pathname, u.search, u.hash);
  } catch {
    return null;
  }
}

/**
 * Maps an href (absolute public URL or same-origin relative path) to an in-app route, or null.
 */
export function inAppPathFromHref(href: string, base?: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    try {
      const resolvedBase =
        base ??
        (typeof window !== 'undefined' ? window.location.href : `${DEFAULT_PUBLIC_APP_ORIGIN}/`);
      const u = new URL(trimmed, resolvedBase);
      return normalizeInAppPathname(u.pathname, u.search, u.hash);
    } catch {
      return null;
    }
  }

  return inAppPathFromPublicUrl(trimmed);
}

/** True when `href` should stay inside the SPA (not open externally). */
export function isInAppHref(href: string, base?: string): boolean {
  return inAppPathFromHref(href, base) !== null;
}

/**
 * Short French label for an in-app Canari link (chat UI). Returns null for external URLs.
 */
export function publicAppLinkLabel(href: string, base?: string): string | null {
  const path = inAppPathFromHref(href, base);
  if (!path) return null;

  const pathname = path.split(/[?#]/)[0] || '/';
  if (pathname === '/') return 'Accueil Canari';
  if (pathname === '/chat' || pathname.startsWith('/chat/')) return 'Discussion';
  if (pathname === '/communities' || pathname.startsWith('/communities/')) return 'Communauté';
  if (pathname === '/notifications' || pathname.startsWith('/notifications/'))
    return 'Notifications';
  if (pathname === '/calendar' || pathname.startsWith('/calendar/')) return 'Agenda';
  if (pathname === '/shop' || pathname.startsWith('/shop/')) return 'Boutique';
  if (pathname.startsWith('/posts/')) return 'Publication';
  if (pathname.startsWith('/forms/')) return 'Formulaire';
  if (pathname.startsWith('/associations/')) return 'Association';
  if (pathname.startsWith('/profile/')) return 'Profil';
  return 'Lien Canari';
}
