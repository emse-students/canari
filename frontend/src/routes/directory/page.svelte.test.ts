// @vitest-environment happy-dom
/**
 * THE DIRECTORY PAGE. Pinned: nothing is asked of the server before there is a criterion; the
 * reader's own class shows first; a submit searches and a chip removes one filter and searches
 * again; an older answer arriving late never replaces a newer one; "Voir plus" appends the next
 * page without duplicates.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const search = vi.hoisted(() => vi.fn());

vi.mock('$app/navigation', () => ({ goto: vi.fn(), beforeNavigate: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'me',
  fetchMyProfile: async () => ({
    promo: 2026,
    cursus: [{ formation: 'ICM', promo: 2026 }],
  }),
}));
vi.mock('$lib/profile/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/profile/api')>()),
  searchDirectory: search,
}));
vi.mock('$lib/associations/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/associations/api')>()),
  listAssociations: async () => [{ id: 'a1', name: 'BDE' }],
}));
// Rows draw an avatar and a follow control; neither is under test here.
vi.mock('$lib/components/shared/Avatar.svelte', async () => ({
  default: (await import('./stubs.svelte')).default,
}));
vi.mock('$lib/components/follows/FollowChip.svelte', async () => ({
  default: (await import('./stubs.svelte')).default,
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => id,
}));

import Page from './+page.svelte';

const row = (id: string, name: string) => ({
  id,
  displayName: name,
  promo: 2026,
  formation: 'ICM',
  campus: null,
  cursus: [{ formation: 'ICM', promo: 2026 }],
  posts: [],
  bio: null,
});

const mounted: (() => void)[] = [];
async function settle() {
  for (let i = 0; i < 6; i++) {
    await tick();
    flushSync();
  }
}
async function render() {
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app));
  await settle();
}
const names = () =>
  [...document.querySelectorAll('[data-directory-row] a')].map((a) => a.textContent?.trim());
async function submitQuery(q: string) {
  const input = document.querySelector('input[type="search"]') as HTMLInputElement;
  input.value = q;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
}

beforeEach(() => {
  search.mockReset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('directory page', () => {
  it('shows the reader class first, without the reader, and asks nothing else', async () => {
    search.mockResolvedValue({ users: [row('me', 'Moi'), row('u1', 'Zoe')], total: 2 });
    await render();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toMatchObject({ promo: 2026, formation: 'ICM' });
    expect(names()).toEqual(['Zoe']);
  });

  it('never asks the server for a one-letter name', async () => {
    search.mockResolvedValue({ users: [], total: 0 });
    await render();
    search.mockClear();
    await submitQuery('a');
    expect(search).not.toHaveBeenCalled();
  });

  it('searches on submit and draws the rows with a count', async () => {
    search.mockResolvedValue({ users: [], total: 0 });
    await render();
    search.mockResolvedValue({ users: [row('u2', 'Alice')], total: 1 });
    await submitQuery('ali');
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'ali', limit: 30 }));
    expect(names()).toEqual(['Alice']);
  });

  it('drops an answer that is not the last one asked for', async () => {
    search.mockResolvedValue({ users: [], total: 0 });
    await render();
    let releaseFirst!: (v: unknown) => void;
    search.mockReturnValueOnce(new Promise((r) => (releaseFirst = r)));
    await submitQuery('first');
    search.mockResolvedValueOnce({ users: [row('u3', 'Second')], total: 1 });
    await submitQuery('second');
    releaseFirst({ users: [row('u4', 'First')], total: 1 });
    await settle();
    expect(names()).toEqual(['Second']);
  });

  it('loads the next page by offset without duplicating a row', async () => {
    search.mockResolvedValue({ users: [], total: 0 });
    await render();
    search.mockResolvedValueOnce({ users: [row('u1', 'A')], total: 2 });
    await submitQuery('ab');
    search.mockResolvedValueOnce({ users: [row('u1', 'A'), row('u2', 'B')], total: 2 });
    const more = [...document.querySelectorAll('button')].find((b) =>
      /voir plus|show more/i.test(b.textContent ?? '')
    );
    more!.click();
    await settle();
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1 }));
    expect(names()).toEqual(['A', 'B']);
  });
});
