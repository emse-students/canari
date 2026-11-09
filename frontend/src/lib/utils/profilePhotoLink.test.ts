import { describe, expect, it, vi } from 'vitest';

const openEcosystemSite = vi.fn();
vi.mock('$lib/navigation/openEcosystemSite', () => ({
  openEcosystemSite: (...a: unknown[]) => openEcosystemSite(...a),
}));

const { MIGALLERY_PROFILE_PHOTO_DEST, openProfilePhotoPage } = await import('./profilePhotoLink');

describe('openProfilePhotoPage', () => {
  it('opens MiGallery\'s "mes photos" page through the one opener', () => {
    openProfilePhotoPage();
    expect(MIGALLERY_PROFILE_PHOTO_DEST).toBe('/mes-photos');
    expect(openEcosystemSite).toHaveBeenCalledWith('migallery', '/mes-photos');
  });

  it("names a dest on MiGallery's handoff allowlist", async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const contract = JSON.parse(
      readFileSync(resolve('..', 'libs', 'contracts', 'ecosystem-sites.json'), 'utf8')
    ) as { sites: Array<{ id: string; dests: string[] }> };
    const migallery = contract.sites.find((s) => s.id === 'migallery');
    expect(migallery?.dests).toContain(MIGALLERY_PROFILE_PHOTO_DEST);
  });
});
