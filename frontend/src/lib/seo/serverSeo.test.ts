import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wordingFor } from '$lib/associations/kindWording';
import { formatDocumentTitle } from '$lib/seo/resolve';

const fetchJson = vi.fn();
vi.mock('$lib/seo/internalApi', () => ({
  SOCIAL_URL: () => 'http://social',
  CORE_URL: () => 'http://core',
  DELIVERY_URL: () => 'http://delivery',
  internalHeaders: () => ({}),
  fetchJson: (...args: unknown[]) => fetchJson(...args),
}));

import { resolveServerSeo } from './serverSeo';

describe('the edit page head, resolved by the KIND of the entity', () => {
  beforeEach(() => fetchJson.mockReset());

  it.each(['association', 'list', 'institution'] as const)(
    'a %s reads the same title the page hands over',
    async (type) => {
      fetchJson.mockResolvedValue({ type });
      const meta = await resolveServerSeo(`/associations/edit-${type}/edit`);
      expect(meta.title).toBe(wordingFor(type).editTitle());
      expect(meta.noindex).toBe(true);
    }
  );

  it('an institution is not titled "Associations" on a direct load', async () => {
    fetchJson.mockResolvedValue({ type: 'institution' });
    const meta = await resolveServerSeo('/associations/bde-inst/edit');
    expect(meta.title).not.toBe('Associations');
    expect(meta.title).toBe(wordingFor('institution').editTitle());
  });

  it('an unknown slug keeps the title the path implies, never a guessed kind', async () => {
    fetchJson.mockResolvedValue(null);
    const meta = await resolveServerSeo('/associations/ghost/edit');
    expect(meta.title).toBe(wordingFor('association').editTitle());
    expect(meta.noindex).toBe(true);
  });
});

describe('a shared post card fits the lengths an unfurler shows', () => {
  beforeEach(() => fetchJson.mockReset());

  const LONG_POST =
    "Le BDE vous invite a la soiree d'integration de la promo 2029, rendez-vous jeudi soir au foyer pour un moment convivial avec musique, jeux et surprises. Venez nombreux, inscription obligatoire via le formulaire en lien, places limitees.";

  it('og:title stays within 60 characters and the description within 125, cut between words', async () => {
    fetchJson.mockResolvedValue({
      markdown: LONG_POST,
      createdAt: '2026-10-17T10:00:00.000Z',
      association: { name: 'Bureau des Eleves', slug: 'bde', logoUrl: null },
      image: null,
    });
    const meta = await resolveServerSeo('/posts/3f1c2b7e-1111-4222-8333-123456789abc');
    const ogTitle = formatDocumentTitle(meta.title);
    expect(ogTitle.length).toBeLessThanOrEqual(60);
    expect(meta.description.length).toBeLessThanOrEqual(125);
    // The word before the ellipsis is a whole word of the post, never a fragment of one.
    for (const cut of [meta.title, meta.description]) {
      expect(cut.endsWith('…')).toBe(true);
      const lastWord = cut.slice(0, -1).trim().split(' ').pop()!;
      expect(LONG_POST.split(/\s+/)).toContain(lastWord);
    }
  });
});
