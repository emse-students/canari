import { SITE, siteOrigin } from '$lib/seo/site';

/** One schema.org node. Values are whatever schema.org accepts for the property. */
export type JsonLdNode = Record<string, unknown>;

/**
 * Serialises JSON-LD for embedding in a `<script>` element.
 *
 * `JSON.stringify` escapes what JSON needs, not what HTML needs: the string `</script>` survives
 * it intact, and inside a script element that byte sequence ENDS the element - everything after it
 * is parsed as markup. Post text, association names and event titles all reach this function, so
 * that is a stored-XSS primitive, not a formatting detail. Escaping `<` as `\u003c` is enough to
 * close it (a JSON parser reads the escape back as `<`), and `&` is escaped alongside it so the
 * payload is also safe to embed where entities are decoded.
 *
 * @see https://www.w3.org/TR/json-ld11/#restrictions-for-contents-of-json-ld-script-elements
 */
export function serializeJsonLd(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, '\\u003c').replace(/&/g, '\\u0026');
}

/** `<script type="application/ld+json">` element for one or more nodes. */
export function renderJsonLdScript(nodes: JsonLdNode[], attributes = ''): string {
  if (nodes.length === 0) return '';
  const payload =
    nodes.length === 1
      ? { '@context': 'https://schema.org', ...nodes[0] }
      : { '@context': 'https://schema.org', '@graph': nodes };
  return `<script type="application/ld+json"${attributes}>${serializeJsonLd(payload)}</script>`;
}

/**
 * The school, as schema.org describes it.
 *
 * Every other node hangs off this one. It is the single strongest ranking signal available here:
 * "Canari" on its own is a bird, and the only thing that disambiguates it is being consistently
 * attached to an establishment that Google already knows about by name, URL and postal address.
 */
export function institutionNode(): JsonLdNode {
  return {
    '@type': 'CollegeOrUniversity',
    name: SITE.institutionName,
    legalName: SITE.institutionLegalName,
    url: SITE.institutionUrl,
    address: {
      '@type': 'PostalAddress',
      streetAddress: SITE.institutionStreet,
      postalCode: SITE.institutionPostalCode,
      addressLocality: SITE.institutionCity,
      addressCountry: 'FR',
    },
  };
}

/** The publisher node every other node points at. */
export function organizationNode(): JsonLdNode {
  const origin = siteOrigin();
  return {
    '@type': 'Organization',
    '@id': `${origin}/#organization`,
    name: SITE.name,
    alternateName: SITE.alternateName,
    url: origin,
    description: SITE.defaultDescription,
    logo: `${origin}${SITE.defaultOgImagePath}`,
    parentOrganization: institutionNode(),
  };
}

/**
 * Organization + WebSite, emitted on the home feed.
 *
 * `WebSite` carries the site name Google may show instead of the domain in a result, and the
 * `SearchAction` declares the in-app search URL - the source of a sitelinks search box when
 * Google decides the site earns one.
 */
export function buildSiteJsonLd(): JsonLdNode[] {
  const origin = siteOrigin();
  return [
    organizationNode(),
    {
      '@type': 'WebSite',
      '@id': `${origin}/#website`,
      name: SITE.name,
      alternateName: SITE.alternateName,
      url: origin,
      description: SITE.defaultDescription,
      inLanguage: SITE.language,
      publisher: { '@id': `${origin}/#organization` },
      potentialAction: {
        '@type': 'SearchAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: `${origin}/posts?q={search_term_string}`,
        },
        'query-input': 'required name=search_term_string',
      },
    },
  ];
}

/** Full JSON-LD script element for the site nodes (used client-side via `{@html}`). */
export function buildSiteJsonLdScriptTag(): string {
  return renderJsonLdScript(buildSiteJsonLd());
}

export interface ArticleJsonLdInput {
  url: string;
  headline: string;
  description: string;
  image?: string;
  authorName?: string | null;
  /** True when the credited author is an association rather than a student. */
  authorIsOrganization?: boolean;
  publishedAt?: string | null;
  modifiedAt?: string | null;
}

/** `Article` for a single post. The headline is what a news-style result prints. */
export function buildArticleJsonLd(input: ArticleJsonLdInput): JsonLdNode {
  const origin = siteOrigin();
  return prune({
    '@type': 'Article',
    mainEntityOfPage: { '@type': 'WebPage', '@id': input.url },
    headline: input.headline,
    description: input.description,
    image: input.image,
    inLanguage: SITE.language,
    datePublished: input.publishedAt ?? undefined,
    dateModified: input.modifiedAt ?? input.publishedAt ?? undefined,
    // An association is not a person, and saying so lets the author node be reconciled with the
    // Organization the association page already declares.
    author: input.authorName
      ? {
          '@type': input.authorIsOrganization ? 'Organization' : 'Person',
          name: input.authorName,
        }
      : undefined,
    publisher: { '@id': `${origin}/#organization` },
  });
}

export interface AssociationJsonLdInput {
  url: string;
  name: string;
  description: string;
  logo?: string;
  email?: string | null;
  memberCount?: number | null;
}

/**
 * `Organization` for an association page.
 *
 * An association is a real body with a name people search for by itself ("BDE Mines
 * Saint-Etienne"), so it gets its own node rather than a generic `WebPage`, with the school as its
 * parent organisation - that is the association Google needs in order to connect the two names.
 */
export function buildAssociationJsonLd(input: AssociationJsonLdInput): JsonLdNode {
  return prune({
    '@type': 'Organization',
    '@id': `${input.url}#organization`,
    name: input.name,
    url: input.url,
    description: input.description,
    logo: input.logo,
    email: input.email ?? undefined,
    memberOf: institutionNode(),
  });
}

export interface EventJsonLdInput {
  name: string;
  description?: string | null;
  startDate: string;
  endDate?: string | null;
  url: string;
  image?: string;
  organizerName?: string | null;
  organizerUrl?: string | null;
}

/**
 * `Event`, the one schema on this site with a real chance of a rich result: Google surfaces events
 * with their dates directly in search, and an agenda is exactly the query a student types.
 *
 * `eventAttendanceMode` and `location` are declared because Google's event guidelines treat a
 * missing location as a warning; every association event happens at the school unless it says
 * otherwise, and the school address is public information.
 */
export function buildEventJsonLd(input: EventJsonLdInput): JsonLdNode {
  return prune({
    '@type': 'Event',
    name: input.name,
    description: input.description ?? undefined,
    startDate: input.startDate,
    endDate: input.endDate ?? undefined,
    url: input.url,
    image: input.image,
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    eventStatus: 'https://schema.org/EventScheduled',
    location: {
      '@type': 'Place',
      name: SITE.institutionName,
      address: {
        '@type': 'PostalAddress',
        streetAddress: SITE.institutionStreet,
        postalCode: SITE.institutionPostalCode,
        addressLocality: SITE.institutionCity,
        addressCountry: 'FR',
      },
    },
    organizer: input.organizerName
      ? prune({
          '@type': 'Organization',
          name: input.organizerName,
          url: input.organizerUrl ?? undefined,
        })
      : undefined,
  });
}

/** `ItemList` wrapping the upcoming events, so the agenda page describes a list and not one event. */
export function buildEventListJsonLd(events: JsonLdNode[]): JsonLdNode {
  return {
    '@type': 'ItemList',
    itemListElement: events.map((event, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      item: event,
    })),
  };
}

/**
 * `BreadcrumbList` for a nested page.
 *
 * Google replaces the URL line of a result with the breadcrumb trail, which is the difference
 * between a result reading `canari-emse.fr > Associations > BDE` and one reading a bare uuid path.
 */
export function buildBreadcrumbJsonLd(trail: { name: string; path: string }[]): JsonLdNode {
  const origin = siteOrigin();
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((step, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: step.name,
      item: `${origin}${step.path}`,
    })),
  };
}

/** Drops undefined values, which schema.org consumers report as malformed properties. */
function prune(node: JsonLdNode): JsonLdNode {
  return Object.fromEntries(Object.entries(node).filter(([, value]) => value !== undefined));
}
