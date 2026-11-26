import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostEntity } from '$lib/posts/api';
import { createUniversalSearch, SERVER_PACE_MS } from './universalSearch.svelte';
import type { SearchProvider, SearchSectionId, SearchSource } from './types';
import { OVERVIEW_LIMIT, SECTION_PAGE } from './types';

/**
 * The open search's state: which section is asked what, and which answer lands. A counter decides
 * the landing, never the order the answers come back in; the pause before a server request only
 * decides WHEN it leaves.
 */
function provider(
  section: SearchSectionId,
  source: SearchSource,
  answer: (q: string, limit: number) => Promise<{ title: string }[]>
): SearchProvider & { calls: { query: string; limit: number }[] } {
  const calls: { query: string; limit: number }[] = [];
  return {
    section,
    source,
    calls,
    async search({ query, limit }) {
      calls.push({ query, limit });
      const rows = await answer(query, limit);
      return { hits: rows.map((r, i) => ({ key: `${i}`, title: r.title })), total: rows.length };
    },
  };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

async function settle() {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}

describe('createUniversalSearch', () => {
  it('asks the device sections at once and the server ones after the pause', async () => {
    const device = provider('settings', 'device', async (q) => [{ title: q }]);
    const server = provider('people', 'server', async (q) => [{ title: q }]);
    const posts = vi.fn(async () => [] as PostEntity[]);
    const s = createUniversalSearch({ providers: [device, server], posts });
    s.setQuery('ga');
    s.setQuery('gal');
    s.setQuery('gala');
    await settle();
    expect(device.calls.map((c) => c.query)).toEqual(['ga', 'gal', 'gala']);
    expect(server.calls).toEqual([]);
    expect(s.sections.people.status).toBe('loading');
    await vi.advanceTimersByTimeAsync(SERVER_PACE_MS);
    await settle();
    expect(server.calls).toEqual([{ query: 'gala', limit: OVERVIEW_LIMIT }]);
    expect(posts).toHaveBeenCalledOnce();
    expect(s.sections.people.hits[0].title).toBe('gala');
    s.dispose();
  });

  it('keeps only the latest answer of a section, whatever order they come back in', async () => {
    const pending: Record<string, (v: { title: string }[]) => void> = {};
    const device = provider(
      'associations',
      'list',
      (q) => new Promise((resolve) => (pending[q] = resolve))
    );
    const s = createUniversalSearch({ providers: [device], posts: async () => [] });
    s.setQuery('ba');
    s.setQuery('bal');
    pending['bal']([{ title: 'Bal' }]);
    await settle();
    pending['ba']([{ title: 'Bad' }]);
    await settle();
    expect(s.sections.associations.hits.map((h) => h.title)).toEqual(['Bal']);
    s.dispose();
  });

  it('asks nothing under two letters', async () => {
    const device = provider('settings', 'device', async () => [{ title: 'x' }]);
    const s = createUniversalSearch({ providers: [device], posts: async () => [] });
    s.setQuery('a');
    await settle();
    expect(device.calls).toEqual([]);
    expect(s.active).toBe(false);
    s.dispose();
  });

  it('gives a chip its own page, and "Afficher plus" the next one', async () => {
    const device = provider('forms', 'list', async () => [{ title: 'f' }]);
    const s = createUniversalSearch({ providers: [device], posts: async () => [] });
    s.setQuery('form');
    await settle();
    s.setFocus('forms');
    await settle();
    s.showMore('forms');
    await settle();
    expect(device.calls.map((c) => c.limit)).toEqual([
      OVERVIEW_LIMIT,
      SECTION_PAGE,
      SECTION_PAGE * 2,
    ]);
    s.setFocus(null);
    await settle();
    expect(device.calls.at(-1)?.limit).toBe(OVERVIEW_LIMIT);
    s.dispose();
  });

  it('runs the post filters at once, alone or with the words (1.8.2 filters kept)', async () => {
    const posts = vi.fn(async () => [{ id: 'p-1' }] as PostEntity[]);
    const s = createUniversalSearch({ providers: [], posts });
    s.setAuthor({ id: 'u-1', name: 'Camille' });
    await settle();
    expect(posts).toHaveBeenLastCalledWith(
      { q: '', authorId: 'u-1', associationId: undefined },
      { limit: OVERVIEW_LIMIT }
    );
    expect(s.active).toBe(true);
    s.setFocus('posts');
    s.setAssociation({ id: 'a-1', name: 'BDE' });
    await settle();
    expect(posts).toHaveBeenLastCalledWith(
      { q: '', authorId: 'u-1', associationId: 'a-1' },
      { limit: SECTION_PAGE }
    );
    s.removePost('p-1');
    expect(s.posts.hits).toEqual([]);
    s.dispose();
  });

  it('says a failed section failed, and keeps the others', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = provider('events', 'list', async () => {
      throw new Error('503');
    });
    const good = provider('settings', 'device', async () => [{ title: 'ok' }]);
    const s = createUniversalSearch({ providers: [bad, good], posts: async () => [] });
    s.setQuery('gala');
    await settle();
    expect(s.sections.events.status).toBe('failed');
    expect(s.sections.settings.status).toBe('done');
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
    s.dispose();
  });

  it('lands nothing once disposed', async () => {
    let release: (v: { title: string }[]) => void = () => {};
    const device = provider('settings', 'device', () => new Promise((r) => (release = r)));
    const s = createUniversalSearch({ providers: [device], posts: async () => [] });
    s.setQuery('gala');
    s.dispose();
    release([{ title: 'late' }]);
    await settle();
    expect(s.sections.settings.hits).toEqual([]);
  });
});
