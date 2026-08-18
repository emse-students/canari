import { parseAnnouncement, localizeAnnouncement } from './announcement.svelte';

/**
 * The client's whole job is to pick a language and refuse to render a blank modal. Both halves are
 * pure, so both are pinned here; everything else about the announcement (who has seen it, who it
 * applies to) is decided server-side by construction and tested there.
 */
describe('parseAnnouncement', () => {
  const valid = {
    id: 'a1',
    titleFr: 'Titre',
    titleEn: 'Title',
    bodyFr: 'Corps',
    bodyEn: 'Body',
  };

  it('accepts a complete announcement', () => {
    expect(parseAnnouncement(valid)).toEqual(valid);
  });

  it('refuses anything that would render as a blank modal', () => {
    // A modal with no way out and nothing in it is worse than no announcement.
    expect(parseAnnouncement(null)).toBeNull();
    expect(parseAnnouncement('nope')).toBeNull();
    expect(parseAnnouncement({})).toBeNull();
    for (const field of ['id', 'titleFr', 'titleEn', 'bodyFr', 'bodyEn'] as const) {
      expect(parseAnnouncement({ ...valid, [field]: '' })).toBeNull();
      expect(parseAnnouncement({ ...valid, [field]: '   ' })).toBeNull();
      expect(parseAnnouncement({ ...valid, [field]: undefined })).toBeNull();
      expect(parseAnnouncement({ ...valid, [field]: 42 })).toBeNull();
    }
  });

  it('reads "no announcement" as no announcement, not as a malformed one', () => {
    expect(parseAnnouncement(null)).toBeNull();
  });
});

describe('localizeAnnouncement', () => {
  const both = {
    id: 'a1',
    titleFr: 'Titre',
    titleEn: 'Title',
    bodyFr: 'Corps',
    bodyEn: 'Body',
  };

  it('picks the language the user chose inside Canari', () => {
    expect(localizeAnnouncement(both, 'fr')).toEqual({ id: 'a1', title: 'Titre', body: 'Corps' });
    expect(localizeAnnouncement(both, 'en')).toEqual({ id: 'a1', title: 'Title', body: 'Body' });
  });

  it('treats any locale that is not English as French, the base locale', () => {
    expect(localizeAnnouncement(both, '').title).toBe('Titre');
    expect(localizeAnnouncement(both, 'de').title).toBe('Titre');
  });
});
