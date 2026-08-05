import { describe, expect, it } from 'vitest';
import { ecosystemCoverCardFor, ecosystemSiteFor } from './ecosystemHosts';

describe('ecosystemSiteFor', () => {
  it('names the four sites of the ecosystem', () => {
    expect(ecosystemSiteFor('gallery.mitv.fr')?.label).toBe('MiGallery');
    expect(ecosystemSiteFor('sky.mitv.fr')?.label).toBe('Sky');
    expect(ecosystemSiteFor('cercle.canari-emse.fr')?.label).toBe('Le Cercle');
    expect(ecosystemSiteFor('portail-etu.emse.fr')?.label).toBe('Portail Etu');
  });

  it('tolerates a www. prefix and an uppercased host', () => {
    expect(ecosystemSiteFor('www.Sky.MiTV.fr')?.label).toBe('Sky');
  });

  it('leaves the rest of the web alone, so its chip stays the hostname', () => {
    expect(ecosystemSiteFor('example.com')).toBeNull();
    // A neighbouring host is not a member: matching is exact, never a suffix.
    expect(ecosystemSiteFor('evil-gallery.mitv.fr.attacker.test')).toBeNull();
  });
});

describe('ecosystemCoverCardFor', () => {
  it('gives the cover card to a MiGallery album', () => {
    const card = ecosystemCoverCardFor(
      'gallery.mitv.fr',
      '/albums/0f3a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8'
    );
    expect(card).not.toBeNull();
    expect(card?.fallbackTitle()).toBeTruthy();
  });

  it('keeps the compact card for the rest of the same site', () => {
    expect(ecosystemCoverCardFor('gallery.mitv.fr', '/mes-photos')).toBeNull();
    expect(ecosystemCoverCardFor('gallery.mitv.fr', '/albums/1/photos')).toBeNull();
  });

  it('returns null for a site that declares no cover path', () => {
    expect(ecosystemCoverCardFor('sky.mitv.fr', '/albums/abc')).toBeNull();
  });
});
