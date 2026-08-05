import {
  buildArticleJsonLd,
  buildAssociationJsonLd,
  buildBreadcrumbJsonLd,
  buildEventJsonLd,
  buildEventListJsonLd,
  buildSiteJsonLd,
  renderJsonLdScript,
  serializeJsonLd,
} from './jsonLd';

describe('serializeJsonLd', () => {
  it('cannot be closed early by the text it carries', () => {
    // JSON.stringify leaves `</script>` byte-for-byte intact, and inside a script element that
    // sequence ends the element - so a post title alone would become an injection point.
    const payload = serializeJsonLd({ headline: '</script><img src=x onerror=alert(1)>' });

    expect(payload).not.toContain('</script>');
    expect(payload).toContain('\\u003c/script');
    expect(JSON.parse(payload)).toEqual({ headline: '</script><img src=x onerror=alert(1)>' });
  });

  it('escapes ampersands too, so the payload survives entity decoding', () => {
    expect(serializeJsonLd({ name: 'Arts & Metiers' })).toContain('\\u0026');
  });
});

describe('renderJsonLdScript', () => {
  it('emits nothing at all for an empty node list', () => {
    expect(renderJsonLdScript([])).toBe('');
  });

  it('inlines a single node and wraps several in a @graph', () => {
    expect(renderJsonLdScript([{ '@type': 'Article' }])).toContain('"@type":"Article"');
    expect(renderJsonLdScript([{ '@type': 'Article' }])).not.toContain('@graph');
    expect(renderJsonLdScript([{ '@type': 'Article' }, { '@type': 'WebSite' }])).toContain(
      '"@graph"'
    );
  });

  it('passes extra attributes through to the element', () => {
    expect(renderJsonLdScript([{ '@type': 'Article' }], ' data-canari-seo')).toContain(
      '<script type="application/ld+json" data-canari-seo>'
    );
  });
});

describe('buildSiteJsonLd', () => {
  it('names the school alongside the site, which is the whole point of the pair', () => {
    const [organization, website] = buildSiteJsonLd() as Record<string, any>[];

    expect(organization['@type']).toBe('Organization');
    expect(organization.parentOrganization['@type']).toBe('CollegeOrUniversity');
    expect(website.alternateName).toContain('EMSE');
    // The publisher is referenced, not duplicated - two Organization nodes with one name is how a
    // graph ends up describing two organisations.
    expect(website.publisher).toEqual({ '@id': organization['@id'] });
  });

  it('declares the search entry point, which is what a sitelinks search box is built from', () => {
    const website = buildSiteJsonLd()[1] as Record<string, any>;
    expect(website.potentialAction['@type']).toBe('SearchAction');
    expect(website.potentialAction.target.urlTemplate).toContain('{search_term_string}');
  });
});

describe('entity nodes', () => {
  it('omits every property it was given nothing for', () => {
    const article = buildArticleJsonLd({
      url: 'https://canari-emse.fr/posts/1',
      headline: 'Titre',
      description: 'Description',
    });

    expect(article).not.toHaveProperty('image');
    expect(article).not.toHaveProperty('author');
    expect(article).not.toHaveProperty('datePublished');
    expect(article.headline).toBe('Titre');
  });

  it('dates a modification to the publication when nothing else is known', () => {
    const article = buildArticleJsonLd({
      url: 'https://canari-emse.fr/posts/1',
      headline: 'T',
      description: 'D',
      publishedAt: '2026-08-05T10:00:00.000Z',
    });

    expect(article.dateModified).toBe('2026-08-05T10:00:00.000Z');
  });

  it('attaches an association to the school rather than leaving it standalone', () => {
    const asso = buildAssociationJsonLd({
      url: 'https://canari-emse.fr/associations/bde',
      name: 'BDE',
      description: 'Le bureau des eleves',
    }) as Record<string, any>;

    expect(asso['@type']).toBe('Organization');
    expect(asso.memberOf['@type']).toBe('CollegeOrUniversity');
    expect(asso.memberOf.address.addressLocality).toContain('Saint');
  });

  it('gives an event the location Google asks for', () => {
    const event = buildEventJsonLd({
      name: 'Gala',
      startDate: '2026-09-01T18:00:00.000Z',
      url: 'https://canari-emse.fr/calendar',
    }) as Record<string, any>;

    expect(event.eventAttendanceMode).toContain('OfflineEventAttendanceMode');
    expect(event.location['@type']).toBe('Place');
    expect(event).not.toHaveProperty('organizer');
  });

  it('numbers the list positions from one', () => {
    const list = buildEventListJsonLd([{ '@type': 'Event' }, { '@type': 'Event' }]) as Record<
      string,
      any
    >;

    expect(list.itemListElement[0].position).toBe(1);
    expect(list.itemListElement[1].position).toBe(2);
  });

  it('builds absolute breadcrumb items, since a crawler resolves them against nothing', () => {
    const crumbs = buildBreadcrumbJsonLd([
      { name: 'Canari', path: '/' },
      { name: 'BDE', path: '/associations/bde' },
    ]) as Record<string, any>;

    expect(crumbs.itemListElement[1].item).toMatch(/^https?:\/\/.+\/associations\/bde$/);
  });
});

describe('article authorship', () => {
  it('credits an association as an Organization, not a Person', () => {
    const asso = buildArticleJsonLd({
      url: 'https://canari-emse.fr/posts/1',
      headline: 'T',
      description: 'D',
      authorName: 'BDE',
      authorIsOrganization: true,
    }) as Record<string, any>;
    expect(asso.author['@type']).toBe('Organization');

    const student = buildArticleJsonLd({
      url: 'https://canari-emse.fr/posts/1',
      headline: 'T',
      description: 'D',
      authorName: 'Jean Dupont',
    }) as Record<string, any>;
    expect(student.author['@type']).toBe('Person');
  });
});
