import { destIsAllowed } from '$lib/navigation/handoffDest';
import { m } from '$lib/paraglide/messages';

/** One sibling site the app launcher opens (MiGallery, Le Cercle, Sky, Portail-etu). */
export interface EcosystemSite {
  id: 'migallery' | 'le-cercle' | 'sky' | 'portail-etu';
  /** The public origin the site answers on TODAY. */
  href: string;
  /**
   * The one-time sign-in handoff is ON for it: Canari, signed in, opens it signed in
   * ({@link openEcosystemSite}). True only under the conditions of `libs/contracts/ecosystem-sites.json`
   * (F3's MiConnect access check at mint, the site's `sub_mode`, its redemption live with handoff
   * sessions stepped up); core-service refuses a mint for any other.
   */
  handoff: boolean;
  /**
   * The closed allowlist of paths a handoff may land on (`{uuid}` is one lowercase UUID segment).
   * The client reads it twice: a link to the site tapped in a message is handed off only when its
   * path is on it ({@link ecosystemSiteLink}), and no other path is ever passed to the site's sign-in.
   */
  dests: readonly string[];
  /**
   * The site's own MiConnect sign-in entry, and the query parameter it reads a return path from
   * (null: it reads none, and the sign-in lands on the site's home). Opened when a mint is refused
   * because MiConnect has a page to show the person first. Null for a site outside MiConnect.
   */
  signIn: { path: string; returnParam: string | null } | null;
  /** Bundled 96 px logo under `static/ecosystem/`. */
  logo: string;
  label: () => string;
}

/**
 * The student sites Canari links to from its app launcher, in the order the launcher draws them.
 *
 * THE ONLY PLACE IN THE CLIENT THEIR ADDRESSES ARE WRITTEN, and a copy of
 * `libs/contracts/ecosystem-sites.json`, which core-service's handoff registry copies too: each side's
 * test asserts its copy equals the file, so the id a client names and the origin the server composes
 * cannot drift (`ecosystemSites.test.ts`). Every one of them is due to move onto an `emse.fr`
 * name the day its certificate is in place (`docs/wiki/infrastructure/estate-migration.md`), and
 * each move is then one line here. An address is changed only once the new name answers over TLS:
 * the old ones keep serving until then, and a link to a name that fails its handshake is a broken
 * button.
 *
 * THE LOGOS ARE BUNDLED, NOT HOTLINKED. Loading them from each site would tie the launcher to three
 * other origins that are all about to be renamed, and would draw a broken image whenever one of
 * them is down - the moment someone most needs to see which site they are opening.
 */
export const ECOSYSTEM_SITES: readonly EcosystemSite[] = [
  {
    id: 'migallery',
    handoff: true,
    href: 'https://gallery.mitv.fr',
    dests: ['/', '/mes-photos', '/albums/{uuid}'],
    // MiGallery's `/api/auth/login` parks `redirectTo` (an in-site path) across the MiConnect round trip.
    signIn: { path: '/api/auth/login', returnParam: 'redirectTo' },
    logo: '/ecosystem/migallery.webp',
    label: () => m.ecosystem_site_migallery(),
  },
  {
    id: 'le-cercle',
    handoff: false,
    href: 'https://cercle.emse.fr',
    dests: ['/'],
    signIn: { path: '/auth/login', returnParam: null },
    logo: '/ecosystem/le-cercle.webp',
    label: () => m.ecosystem_site_le_cercle(),
  },
  {
    id: 'sky',
    handoff: false,
    href: 'https://sky.emse.fr',
    dests: ['/'],
    signIn: { path: '/auth/login', returnParam: null },
    logo: '/ecosystem/sky.webp',
    label: () => m.ecosystem_site_sky(),
  },
  {
    id: 'portail-etu',
    handoff: false,
    href: 'https://portail-etu.emse.fr',
    dests: [],
    signIn: null,
    logo: '/ecosystem/portail-etu.webp',
    label: () => m.ecosystem_site_portail_etu(),
  },
];

/**
 * The flagged site and allowlisted path a link written in a message or a post points at, or null
 * when it is anything else - then it opens as any external link does.
 *
 * A link someone ELSE wrote is about to open the reader's own signed-in session, so the match is
 * strict: the origin is a registered site's exactly, its handoff flag is on, the URL carries no
 * credentials, no query and no fragment (none of which a handoff could carry, and dropping them
 * would open another page than the one written), and the path the browser would load (`URL`'s
 * normalised `pathname`) is exactly one of the site's `dests` - pages a handoff session can browse
 * but never change anything from (the site's step-up, design note section 3.7).
 */
export function ecosystemSiteLink(
  href: string,
  sites: readonly EcosystemSite[] = ECOSYSTEM_SITES
): { site: EcosystemSite; dest: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const site = sites.find((s) => s.href === url.origin);
  if (!site?.handoff) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return destIsAllowed(url.pathname, site.dests) ? { site, dest: url.pathname } : null;
}
