/**
 * THE PUBLIC PAGE AS A HUB: which sections exist, where each one lives, where Back goes, and which
 * old links still land. A section is a route segment, so the segment is user input: a typed `/shop`
 * on an association with nothing to sell must not draw an empty section.
 */
import { describe, it, expect } from 'vitest';
import {
  PUBLIC_SECTIONS,
  mayOpenPublicSection,
  parsePublicSection,
  publicRedirectTarget,
  publicSectionHref,
  publicSectionWidth,
  publicTrail,
  visiblePublicSections,
} from './publicSections';
import { previousCrumb } from '$lib/components/navigation/breadcrumb';
import { ASSOCIATION_SECTION_PATH, resolveSeoForPath } from '$lib/seo/resolve';
import { load as associationLoad } from '../../routes/associations/[slug]/[[section]]/+page';

const nothing = { productCount: 0, partnershipCount: 0 };

describe('which sections exist', () => {
  it('always offers the calendar and the members', () => {
    expect(visiblePublicSections(nothing)).toEqual(['calendar', 'members']);
  });

  it('adds the shop on a product and the partnerships on a card, in hub order', () => {
    expect(visiblePublicSections({ productCount: 2, partnershipCount: 0 })).toEqual([
      'calendar',
      'members',
      'shop',
    ]);
    expect(visiblePublicSections({ productCount: 1, partnershipCount: 3 })).toEqual([
      ...PUBLIC_SECTIONS,
    ]);
  });

  it('refuses a typed conditional section its page cannot fill', () => {
    expect(mayOpenPublicSection('shop', nothing)).toBe(false);
    expect(mayOpenPublicSection('partnerships', nothing)).toBe(false);
    expect(mayOpenPublicSection('calendar', nothing)).toBe(true);
  });

  it('narrows an untrusted segment to a key and nothing else', () => {
    expect(parsePublicSection('shop')).toBe('shop');
    expect(parsePublicSection('edit')).toBeNull();
    expect(parsePublicSection('about')).toBeNull();
    expect(parsePublicSection(null)).toBeNull();
  });
});

describe('the width follows the section', () => {
  it('draws the walls and the month at grid, the hub and the roster at tool', () => {
    expect(publicSectionWidth(null)).toBe('tool');
    expect(publicSectionWidth('members')).toBe('tool');
    expect(publicSectionWidth('calendar')).toBe('grid');
    expect(publicSectionWidth('shop')).toBe('grid');
    expect(publicSectionWidth('partnerships')).toBe('grid');
  });
});

describe('Back goes up exactly one level', () => {
  const labels = {
    directory: 'Associations',
    directoryHref: '/associations',
    asso: 'BDE',
    section: 'Calendrier',
  };

  it('section -> hub', () => {
    const trail = publicTrail('/associations', 'bde', 'calendar', labels);
    expect(trail.map((c) => c.label)).toEqual(['Associations', 'BDE', 'Calendrier']);
    expect(previousCrumb(trail)?.href).toBe('/associations/bde');
    expect(trail.at(-1)?.href).toBe('/associations/bde/calendar');
  });

  it('hub -> the directory', () => {
    const trail = publicTrail('/associations', 'bde', null, labels);
    expect(previousCrumb(trail)).toEqual({ label: 'Associations', href: '/associations' });
  });

  it('a list stays under /lists at every level', () => {
    const trail = publicTrail('/lists', 'liste-x', 'members', {
      ...labels,
      directoryHref: '/lists',
    });
    expect(trail.map((c) => c.href)).toEqual([
      '/lists',
      '/lists/liste-x',
      '/lists/liste-x/members',
    ]);
  });

  it('keeps a hub crumb, named by the slug, until the entity name is known', () => {
    const trail = publicTrail('/associations', 'bde', null, { ...labels, asso: undefined });
    expect(trail.map((c) => c.label)).toEqual(['Associations', 'bde']);
  });

  it('encodes the slug in every link', () => {
    expect(publicSectionHref('/associations', 'a b', 'shop')).toBe('/associations/a%20b/shop');
  });
});

describe('links written before sections became segments', () => {
  const to = (segment: string | undefined, query = '') =>
    publicRedirectTarget('/associations', 'bde', segment, new URLSearchParams(query));

  it('sends the post link to the calendar segment and keeps fromPost', () => {
    expect(to(undefined, '?section=calendar&fromPost=p1')).toBe(
      '/associations/bde/calendar?fromPost=p1'
    );
  });

  it('sends ?section=about and an unknown name to the hub, keeping the rest of the query', () => {
    expect(to(undefined, '?section=about')).toBe('/associations/bde');
    expect(to(undefined, '?section=nope&x=1')).toBe('/associations/bde?x=1');
  });

  it('sends an unknown segment to the hub and lets the hub and a known segment through', () => {
    expect(to('nope')).toBe('/associations/bde');
    expect(to(undefined)).toBeNull();
    expect(to('members')).toBeNull();
  });

  it('serves lists under /lists', () => {
    expect(
      publicRedirectTarget('/lists', 'l', undefined, new URLSearchParams('section=members'))
    ).toBe('/lists/l/members');
  });
});

describe('a section is never a second indexable page of the entity', () => {
  it('resolves noindex on the server answer for every section', () => {
    for (const s of PUBLIC_SECTIONS) {
      expect(ASSOCIATION_SECTION_PATH.test(`/associations/bde/${s}`), s).toBe(true);
      expect(resolveSeoForPath(`/associations/bde/${s}`).noindex, s).toBe(true);
    }
  });

  it('keeps the hub indexable and its canonical path its own', () => {
    const hub = resolveSeoForPath('/associations/bde');
    expect(hub.noindex).toBeUndefined();
    expect(hub.path).toBe('/associations/bde');
  });

  it('marks the segment page noindex in the load, and not the hub', () => {
    type Args = Parameters<typeof associationLoad>[0];
    const run = (section: string | undefined) =>
      associationLoad({
        params: { slug: 'bde', section },
        url: new URL('http://x/associations/bde'),
      } as unknown as Args) as { seo: { noindex?: boolean; path?: string } };
    expect(run('calendar').seo.noindex).toBe(true);
    expect(run(undefined).seo.noindex).toBeUndefined();
    expect(run(undefined).seo.path).toBe('/associations/bde');
  });
});
