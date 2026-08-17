/**
 * The sites Canari shares its users with.
 *
 * A link preview shows the HOST in its chip, because a hostname is short by
 * construction and says the one thing the title does not: where the link goes.
 * That is right for the open web and needlessly cryptic for the four sites of
 * our own ecosystem, whose names the reader already knows - `sky.mitv.fr` is
 * Sky to nobody but the person who deployed it. This registry is the single
 * place that maps a host to the name we call it by, and it also carries the
 * paths a site describes richly enough to deserve the cover-first card.
 *
 * Canari itself is deliberately absent: `isInAppHref` catches its own links
 * upstream of anything here, and they take the in-app branch of the card.
 *
 * Deliberately NOT here: bundled logos. The card already resolves each site's
 * own favicon from the site itself, which stays correct through a rebrand and
 * costs us no asset to keep in sync.
 */
import { m } from '$lib/paraglide/messages';

/** A path pattern a site renders as a large cover, plus the title to use when it has none. */
export interface EcosystemCoverCard {
  /** Matched against the URL pathname (leading slash included, no query). */
  pattern: RegExp;
  /** Message key resolver, called when the fetched preview carries no title. */
  fallbackTitle: () => string;
  /**
   * The square (1:1) cover for this page, when the site publishes one.
   *
   * An `og:image` is 1200x630 by contract, and the card shows it in a narrow
   * full-height column: cropping a 1.9:1 image to that leaves a band of the
   * middle of the photo. A site that also serves the cover square gets shown
   * the square one. Built from the URL alone, so it needs no preview fetch and
   * paints while the metadata is still in flight.
   */
  squareCover?: (url: URL) => string | null;
}

export interface EcosystemSite {
  /** Human name shown in the preview chip, in place of the bare hostname. */
  label: string;
  /** Paths worth a cover-first card. Undefined means the ordinary compact card. */
  coverCard?: EcosystemCoverCard;
}

/**
 * Keyed by hostname WITHOUT a `www.` prefix - callers strip it, as the card
 * already does when it parses the URL.
 *
 * The hostnames are the production ones, read from each repo rather than
 * guessed: `docs/PROD-TEST-CERCLE.md` for the Cercle (the endpoint proven live
 * on 2026-08-03), the deployed origins for the other three.
 */
/** `/albums/<uuid>`, with the id captured so the cover endpoint can be built from it. */
const MIGALLERY_ALBUM_PATH = /^\/albums\/([0-9a-f-]+)\/?$/i;

const ECOSYSTEM_SITES: Readonly<Record<string, EcosystemSite>> = {
  'gallery.mitv.fr': {
    label: 'MiGallery',
    coverCard: {
      pattern: MIGALLERY_ALBUM_PATH,
      fallbackTitle: () => m.migallery_album_fallback(),
      // Public for every album, and stable per album: the response revalidates
      // on its ETag, so a changed cover is picked up without a versioned URL.
      squareCover: (url) => {
        const id = MIGALLERY_ALBUM_PATH.exec(url.pathname)?.[1];
        return id ? `${url.origin}/api/albums/${id}/cover` : null;
      },
    },
  },
  'sky.mitv.fr': { label: 'Sky' },
  'cercle.canari-emse.fr': { label: 'Le Cercle' },
  'portail-etu.emse.fr': { label: 'Portail Etu' },
};

/** The registry entry for a hostname, or null for the rest of the web. */
export function ecosystemSiteFor(host: string): EcosystemSite | null {
  return ECOSYSTEM_SITES[host.replace(/^www\./, '').toLowerCase()] ?? null;
}

/**
 * The cover card this URL deserves, or null.
 *
 * Both halves must match: a site with a cover pattern still shows the compact
 * card for every path outside it, since the pattern is exactly the set of pages
 * we know carry an image worth the space.
 */
export function ecosystemCoverCardFor(host: string, path: string): EcosystemCoverCard | null {
  const site = ecosystemSiteFor(host);
  if (!site?.coverCard) return null;
  return site.coverCard.pattern.test(path) ? site.coverCard : null;
}

/**
 * The square cover URL for a link, or null when the site publishes none.
 *
 * Unparseable input is a null rather than a throw: the caller is rendering a
 * card for a string a user typed.
 */
export function ecosystemSquareCoverUrl(href: string): string | null {
  try {
    const url = new URL(href);
    const card = ecosystemCoverCardFor(url.hostname, url.pathname);
    return card?.squareCover?.(url) ?? null;
  } catch {
    return null;
  }
}
