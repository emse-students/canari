import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wordingFor } from '$lib/associations/kindWording';

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
