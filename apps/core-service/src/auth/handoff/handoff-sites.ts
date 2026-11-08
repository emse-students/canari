/**
 * THE HANDOFF REGISTRY - the sites core-service may mint a sign-in handoff for, and where on each
 * a token may land. Closed and server-side: the client names a site by id and never supplies an
 * origin, so the mint route cannot become an open redirect and a token cannot be sent anywhere
 * else (docs/wiki/backlog.d/sign-in-handoff-to-the-ecosystem-sites-and-migallery-notifications.md,
 * section 3.2).
 *
 * A copy of `libs/contracts/ecosystem-sites.json`, asserted equal by `handoff-sites.spec.ts`; the
 * frontend's `ecosystemSites.ts` asserts the same file, so the two sides cannot drift.
 */

/** One sibling site, as the contract lists it. */
export interface EcosystemSiteContract {
  id: string;
  origin: string;
  /** Signs in through MiConnect: the ONLY condition for being in the handoff registry. */
  miconnect: boolean;
  /** The handoff is ON for it: true only once its own `/auth/handoff` is live in production. */
  handoff: boolean;
  /** The paths a token may land on; `{uuid}` is one lowercase UUID segment. */
  dests: readonly string[];
}

export const ECOSYSTEM_SITES: readonly EcosystemSiteContract[] = [
  {
    id: 'migallery',
    origin: 'https://gallery.mitv.fr',
    miconnect: true,
    handoff: false,
    dests: ['/', '/mes-photos', '/mes-photos/confirmer', '/albums/{uuid}'],
  },
  {
    id: 'le-cercle',
    origin: 'https://cercle.emse.fr',
    miconnect: true,
    handoff: false,
    dests: ['/'],
  },
  { id: 'sky', origin: 'https://sky.emse.fr', miconnect: true, handoff: false, dests: ['/'] },
  {
    id: 'portail-etu',
    origin: 'https://portail-etu.emse.fr',
    miconnect: false,
    handoff: false,
    dests: [],
  },
];

/** The site's page that redeems a token, read from the fragment. */
export const HANDOFF_LANDING_PATH = '/auth/handoff';

/** The typed codes of a refused mint, as the contract names them. */
export const HandoffRefusal = {
  /** 404 - this estate holds no signing key: the handoff does not exist here. */
  notOffered: 'HANDOFF_NOT_OFFERED',
  /** 400 - an `aud` that is not a MiConnect site of the registry. */
  unknownSite: 'HANDOFF_UNKNOWN_SITE',
  /** 400 - a registered site whose redemption is not live yet (`handoff: false`). */
  siteNotEnabled: 'HANDOFF_SITE_NOT_ENABLED',
  /** 400 - a `dest` outside the site's allowlist. */
  badDest: 'HANDOFF_BAD_DEST',
} as const;

export type HandoffRefusalCode = (typeof HandoffRefusal)[keyof typeof HandoffRefusal];

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether `dest` is exactly one of `allowed`, segment by segment, `{uuid}` matching one lowercase
 * UUID. No normalisation: a query, a fragment, a trailing slash, `..` or a doubled slash is simply
 * not on the list.
 */
export function destIsAllowed(dest: string, allowed: readonly string[]): boolean {
  if (!dest.startsWith('/')) return false;
  const parts = dest.split('/');
  return allowed.some((pattern) => {
    const want = pattern.split('/');
    if (want.length !== parts.length) return false;
    return want.every((seg, i) =>
      seg === '{uuid}' ? UUID_SEGMENT.test(parts[i]) : seg === parts[i]
    );
  });
}

/** The registry entry a mint may use for `aud`, or the refusal that says why not. */
export function handoffSite(
  aud: unknown,
  sites: readonly EcosystemSiteContract[] = ECOSYSTEM_SITES
): { site: EcosystemSiteContract } | { refusal: HandoffRefusalCode } {
  const site = typeof aud === 'string' ? sites.find((s) => s.id === aud && s.miconnect) : undefined;
  if (!site) return { refusal: HandoffRefusal.unknownSite };
  if (!site.handoff) return { refusal: HandoffRefusal.siteNotEnabled };
  return { site };
}
