/** Android applicationId / iOS bundle identifier (tauri.conf.json `identifier`). */
export const MOBILE_APP_PACKAGE = 'fr.emse.canari';

/** Hosts that declare verified App Links / Universal Links for Canari. */
export const MOBILE_APP_LINK_HOSTS = ['canari-emse.fr', 'www.canari-emse.fr'] as const;

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
