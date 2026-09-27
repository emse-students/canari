import { m } from '$lib/paraglide/messages';

/** One sibling site the app launcher opens (MiGallery, Le Cercle, Sky, Portail-etu). */
export interface EcosystemSite {
  id: 'migallery' | 'le-cercle' | 'sky' | 'portail-etu';
  /** The public origin the site answers on TODAY. */
  href: string;
  /** Bundled 96 px logo under `static/ecosystem/`. */
  logo: string;
  label: () => string;
}

/**
 * The student sites Canari links to from its app launcher, in the order the launcher draws them.
 *
 * THE ONLY PLACE THEIR ADDRESSES ARE WRITTEN. Every one of them is due to move onto an `emse.fr`
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
    href: 'https://gallery.mitv.fr',
    logo: '/ecosystem/migallery.webp',
    label: () => m.ecosystem_site_migallery(),
  },
  {
    id: 'le-cercle',
    href: 'https://cercle.canari-emse.fr',
    logo: '/ecosystem/le-cercle.webp',
    label: () => m.ecosystem_site_le_cercle(),
  },
  {
    id: 'sky',
    href: 'https://sky.mitv.fr',
    logo: '/ecosystem/sky.webp',
    label: () => m.ecosystem_site_sky(),
  },
  {
    id: 'portail-etu',
    href: 'https://portail-etu.emse.fr',
    logo: '/ecosystem/portail-etu.webp',
    label: () => m.ecosystem_site_portail_etu(),
  },
];
