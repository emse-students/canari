// @vitest-environment happy-dom
/**
 * The post search's two filters (owner, 2026-11-19): each is a button until chosen, then a removable
 * chip; choosing an association reports its id and name to the page.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/associations/api', () => ({
  listAssociationDirectory: () =>
    Promise.resolve([
      { id: 'a1', name: 'Club Photo' },
      { id: 'a2', name: 'Bureau des Élèves' },
    ]),
}));
vi.mock('$lib/components/shared/UserAutocomplete.svelte', async () => ({
  default: (await import('../reels/AvatarStub.test-helper.svelte')).default,
}));

import PostSearchFilters from './PostSearchFilters.svelte';

let mounted: Record<string, unknown> | null = null;
afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = null;
  document.body.innerHTML = '';
});

function render(props: Record<string, unknown>) {
  mounted = mount(PostSearchFilters, { target: document.body, props: props as never });
  flushSync();
}

it('offers both filters until one is chosen, then draws the choice as a removable chip', () => {
  const onAuthor = vi.fn();
  render({
    author: { id: 'u1', name: 'Marie' },
    association: null,
    onAuthor,
    onAssociation: vi.fn(),
  });
  expect(document.body.textContent).toContain('Marie');
  expect(document.body.textContent).toContain(m.posts_search_filter_association());
  expect(document.body.textContent).not.toContain(m.posts_search_filter_author());
  const remove = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${m.posts_search_filter_remove_aria({ name: 'Marie' })}"]`
  );
  remove!.click();
  expect(onAuthor).toHaveBeenCalledWith(null);
});

it('reports the association the reader picks, by id and name', async () => {
  const onAssociation = vi.fn();
  render({ author: null, association: null, onAuthor: vi.fn(), onAssociation });
  const open = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(m.posts_search_filter_association())
  );
  open!.click();
  await vi.waitFor(() => {
    flushSync();
    expect(document.body.textContent).toContain('Club Photo');
  });
  const pick = [...document.querySelectorAll<HTMLButtonElement>('li button')].find((b) =>
    b.textContent?.includes('Club Photo')
  );
  pick!.click();
  expect(onAssociation).toHaveBeenCalledWith({ id: 'a1', name: 'Club Photo' });
});
