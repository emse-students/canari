/** Android applicationId / iOS bundle identifier (tauri.conf.json `identifier`). */
export const MOBILE_APP_PACKAGE = 'fr.emse.canari';

/**
 * The app's custom URL scheme as `URL.protocol` spells it. The scheme IS the identifier, so this
 * is derived rather than spelled: a second package id (a side-by-side dev build) changes one
 * constant, not every deep link.
 */
export const MOBILE_APP_PROTOCOL = `${MOBILE_APP_PACKAGE}:`;

/**
 * A deep link into the app: `<identifier>://<hostAndPath>`.
 *
 * @param hostAndPath What follows `://` - a host such as `callback`, then an optional path and query.
 */
export function appDeepLink(hostAndPath: string): string {
  return `${MOBILE_APP_PACKAGE}://${hostAndPath}`;
}

/** Where Authentik sends a Tauri mobile login back: the deep-link plugin registers this host. */
export const OIDC_MOBILE_REDIRECT_URI = appDeepLink('callback');

/**
 * Hosts that declare verified App Links / Universal Links for Canari.
 *
 * `www` is intentionally excluded: it only 301-redirects to the apex, and
 * Google Play rejects App Link domains that are not reachable without redirect.
 *
 * `canari.emse.fr` is claimed ADDITIVELY (phase 2 of the estate migration, see
 * docs/wiki/infrastructure/estate-migration.md#the-deep-links-are-the-one-thing-a-redirect-cannot-fix):
 * both hosts stay claimed for several releases, an installation never updated keeps opening
 * `canari-emse.fr` for ever, and no date is set here for dropping it.
 */
export const MOBILE_APP_LINK_HOSTS = ['canari-emse.fr', 'canari.emse.fr'] as const;

/**
 * SPA path prefixes opened in the native app when the user taps an https link.
 * Keep in sync with {@link import('$lib/utils/publicAppUrl').IN_APP_ROUTE_RE}.
 */
export const MOBILE_UNIVERSAL_LINK_PATHS = [
  '/posts/*',
  '/forms/*',
  '/associations/*',
  '/profile/*',
  '/chat',
  '/chat/*',
  '/communities',
  '/communities/*',
  '/c/join/*',
  '/g/join/*',
  '/notifications',
  '/notifications/*',
  '/calendar',
  '/calendar/*',
  '/shop',
  '/shop/*',
  '/',
] as const;

const EXCLUDED_UNIVERSAL_PATHS = [
  'NOT /api/*',
  'NOT /auth/*',
  'NOT /admin/*',
  'NOT /dev/*',
] as const;

/**
 * The same claim as {@link MOBILE_UNIVERSAL_LINK_PATHS}, in the shape an Android
 * intent-filter takes (`plugins.deep-link.mobile` in `tauri.conf.json`).
 *
 * The two platforms carry this claim in different files, and nothing compares
 * them: iOS reads the served `apple-app-site-association`, Android reads the
 * intent-filter compiled into the APK - `assetlinks.json` has no notion of a
 * path at all. So a path restriction written for one platform has **no effect**
 * on the other, which is how Android came to claim every `canari-emse.fr` URL
 * including `/auth/callback`, capturing the OIDC redirect meant for the browser.
 *
 * Android has no negation, so the `NOT` entries need no counterpart: what is not
 * listed is not claimed. `/x/*` becomes a prefix, anything else an exact path.
 */
export function androidAppLinkPaths(): { path: string[]; pathPrefix: string[] } {
  const path: string[] = [];
  const pathPrefix: string[] = [];

  for (const entry of MOBILE_UNIVERSAL_LINK_PATHS) {
    // `/posts/*` -> prefix `/posts/`; Apple's `*` matches the remainder, which is
    // exactly what android:pathPrefix does.
    if (entry.endsWith('/*')) pathPrefix.push(entry.slice(0, -1));
    else path.push(entry);
  }

  return { path, pathPrefix };
}

/**
 * Whether the app claims `pathname` on its link hosts - the same test Android's intent-filter and
 * iOS's association file apply, read from {@link MOBILE_UNIVERSAL_LINK_PATHS}.
 *
 * Needed wherever a page offers to open ITSELF in the app: an Android intent naming the app's
 * package matches only its claimed filter, so offering an unclaimed path would send the user to
 * the store fallback although the app is installed.
 */
export function isClaimedAppLinkPath(pathname: string): boolean {
  const { path, pathPrefix } = androidAppLinkPaths();
  return path.includes(pathname) || pathPrefix.some((prefix) => pathname.startsWith(prefix));
}

/** Parses `VITE_ANDROID_APP_LINK_SHA256` (comma- or whitespace-separated SHA-256 fingerprints). */
export function parseAndroidSha256Fingerprints(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((s) => s.trim().toUpperCase().replace(/:/g, ''))
        .filter(Boolean)
        .map((hex) => hex.match(/.{1,2}/g)?.join(':') ?? hex)
    ),
  ];
}

/**
 * Builds Digital Asset Links JSON for Android.
 *
 * Declares both `handle_all_urls` (App Link verification) and `get_login_creds`
 * (credential sharing / Sign-in with saved passwords), which Google Play requires
 * to enable credential sharing for the verified domains.
 */
export function buildAssetLinksJson(fingerprints: string[]): string {
  const targets =
    fingerprints.length > 0
      ? [
          {
            relation: [
              'delegate_permission/common.handle_all_urls',
              'delegate_permission/common.get_login_creds',
            ],
            target: {
              namespace: 'android_app',
              package_name: MOBILE_APP_PACKAGE,
              sha256_cert_fingerprints: fingerprints,
            },
          },
        ]
      : [];

  return `${JSON.stringify(targets, null, 2)}\n`;
}

/** Builds Apple App Site Association JSON for Universal Links. */
export function buildAppleAppSiteAssociationJson(teamId: string | undefined): string {
  const tid = teamId?.trim();
  const paths = [...MOBILE_UNIVERSAL_LINK_PATHS, ...EXCLUDED_UNIVERSAL_PATHS];

  const details = tid
    ? [
        {
          appID: `${tid}.${MOBILE_APP_PACKAGE}`,
          paths,
        },
      ]
    : [];

  const body = {
    applinks: {
      apps: [],
      details,
    },
  };

  return `${JSON.stringify(body, null, 2)}\n`;
}
