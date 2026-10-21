import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wordingFor } from '$lib/associations/kindWording';
import { formatDocumentTitle } from '$lib/seo/resolve';
import { UpstreamUnavailableError, degradedHeaders } from '$lib/seo/upstream';

const fetchJson = vi.fn();
vi.mock('$lib/seo/internalApi', () => ({
  SOCIAL_URL: () => 'http://social',
  CORE_URL: () => 'http://core',
  DELIVERY_URL: () => 'http://delivery',
  internalHeaders: () => ({}),
  fetchJson: (...args: unknown[]) => fetchJson(...args),
  fetchJsonOrThrow: (...args: unknown[]) => fetchJson(...args),
}));

import { resolveServerSeo } from './serverSeo';

describe('the edit page head, resolved by the KIND of the entity', () => {
  beforeEach(() => fetchJson.mockReset());

  it.each(['association', 'list', 'institution'] as const)(
    'a %s reads the same title the page hands over',
    async (type) => {
      fetchJson.mockResolvedValue({ type });
      const { meta } = await resolveServerSeo(`/associations/edit-${type}/edit`);
      expect(meta.title).toBe(wordingFor(type).editTitle());
      expect(meta.noindex).toBe(true);
    }
  );

  it('an institution is not titled "Associations" on a direct load', async () => {
    fetchJson.mockResolvedValue({ type: 'institution' });
    const { meta } = await resolveServerSeo('/associations/bde-inst/edit');
    expect(meta.title).not.toBe('Associations');
    expect(meta.title).toBe(wordingFor('institution').editTitle());
  });

  it('an unknown slug keeps the title the path implies, never a guessed kind', async () => {
    fetchJson.mockResolvedValue(null);
    const { meta } = await resolveServerSeo('/associations/ghost/edit');
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
    const { meta } = await resolveServerSeo('/posts/3f1c2b7e-1111-4222-8333-123456789abc');
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

const POST_PATH = '/posts/3f1c2b7e-1111-4222-8333-123456789abc';
const POST = {
  markdown: 'Le gala arrive',
  createdAt: '2026-10-17T10:00:00.000Z',
  association: { name: 'Bureau des Eleves', slug: 'bde', logoUrl: '/api/media/public/logo-1' },
  image: null,
};

describe('a shared post card declares the one shape the service renders', () => {
  beforeEach(() => fetchJson.mockReset());

  it('points at the stable preview-image URL with 1200x630 image/jpeg, logo post or photo post', async () => {
    for (const image of [null, { width: 800, height: 600 }]) {
      fetchJson.mockResolvedValue({ ...POST, image });
      const { meta } = await resolveServerSeo(`${POST_PATH}${image ? '' : '/'}`);
      expect(meta.image).toMatch(/\/api\/public\/posts\/[^/?]+\/preview-image$/);
      expect([meta.imageWidth, meta.imageHeight, meta.imageType]).toEqual([
        1200,
        630,
        'image/jpeg',
      ]);
    }
  });
});

describe('a transport failure of the enrichment is not a refusal, and is never remembered', () => {
  beforeEach(() => fetchJson.mockReset());

  it('flags the generic head degraded, warns, and asks the service AGAIN on the next request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = '/posts/aaaaaaaa-1111-4222-8333-123456789abc';
    fetchJson.mockRejectedValueOnce(new UpstreamUnavailableError('http://social/x', 'timeout'));
    const first = await resolveServerSeo(path);
    expect(first.degraded).toBe(true);
    expect(first.meta.title).toBe('Publication');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DEGRADED head'));

    // The next unfurler retry gets the real card: nothing was cached for the failure.
    fetchJson.mockResolvedValueOnce(POST);
    const second = await resolveServerSeo(path);
    expect(second.degraded).toBe(false);
    expect(second.meta.description).toContain('Le gala arrive');
    expect(fetchJson).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('caches a REFUSAL like any answer: the service said no, asking again would say it again', async () => {
    const path = '/posts/bbbbbbbb-1111-4222-8333-123456789abc';
    fetchJson.mockResolvedValue(null);
    const first = await resolveServerSeo(path);
    const second = await resolveServerSeo(path);
    expect(first.degraded).toBe(false);
    expect(second.degraded).toBe(false);
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it('serves a degraded page no-store with the marker nginx logs', () => {
    expect(degradedHeaders()).toEqual({ 'Cache-Control': 'no-store', 'X-Canari-Degraded': '1' });
  });

  it('rethrows what is not a transport failure, for the hook to log', async () => {
    fetchJson.mockRejectedValueOnce(new Error('boom'));
    await expect(resolveServerSeo('/posts/cccccccc-1111-4222-8333-123456789abc')).rejects.toThrow(
      'boom'
    );
  });
});

describe('the agenda page is held to the same rule', () => {
  beforeEach(() => fetchJson.mockReset());

  it('a timeout of the agenda feed is degraded and not cached as an agenda with no events', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchJson.mockRejectedValue(new UpstreamUnavailableError('http://social/feed', 'timeout'));
    const first = await resolveServerSeo('/calendar');
    expect(first.degraded).toBe(true);
    expect(first.meta.jsonLd).toBeUndefined();

    fetchJson.mockResolvedValue([]);
    const second = await resolveServerSeo('/calendar');
    expect(second.degraded).toBe(false);
    warn.mockRestore();
  });
});
