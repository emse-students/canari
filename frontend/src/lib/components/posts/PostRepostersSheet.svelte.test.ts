// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';

/**
 * The author's "Republie par N personnes" sheet (WP-F6, owner 2026-11-02): the reposters listed,
 * "Retirer" removes ONE after a confirmation, a repost already gone counts as removed, and a refused
 * removal puts the row back.
 */
const listPostReposters = vi.fn();
const removePostRepost = vi.fn();
vi.mock('$lib/posts/reposters', () => ({
  MEMBER_REPOST_NOT_LISTED: 'MEMBER_REPOST_NOT_LISTED',
  listPostReposters: (...a: unknown[]) => listPostReposters(...a),
  removePostRepost: (...a: unknown[]) => removePostRepost(...a),
}));
const showConfirm = vi.fn(async () => true);
vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm: () => showConfirm() }));
vi.mock('$lib/utils/users/displayName', () => ({
  peekUserDisplayName: (id: string) => id.toUpperCase(),
  resolveUserDisplayName: async (id: string) => id.toUpperCase(),
  getUserDisplayNameSync: (id: string) => id.toUpperCase(),
}));

vi.mock('$lib/components/shared/Avatar.svelte', () => ({ default: () => {} }));

const { default: PostRepostersSheet } = await import('./PostRepostersSheet.svelte');

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const row = (userId: string) => ({ userId, createdAt: '2026-11-02T09:00:00Z', cursor: userId });

async function open(onRemoved = vi.fn()) {
  const instance = mount(PostRepostersSheet, {
    target: document.body,
    props: { open: true, postId: 'p1', onClose: vi.fn(), onRemoved },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  await vi.waitFor(() => expect(listPostReposters).toHaveBeenCalledWith('p1'));
  await tick();
  return onRemoved;
}

const listed = () =>
  [...document.querySelectorAll('[data-reposter-remove]')].map((b) =>
    b.getAttribute('data-reposter-remove')
  );

async function remove(userId: string) {
  (document.querySelector(`[data-reposter-remove="${userId}"]`) as HTMLButtonElement).click();
  await vi.waitFor(() => expect(removePostRepost).toHaveBeenCalled());
  await tick();
  await tick();
}

describe('PostRepostersSheet', () => {
  it('lists the reposters and removes ONE after a confirmation', async () => {
    listPostReposters.mockResolvedValue([row('marie'), row('yann')]);
    removePostRepost.mockResolvedValue(undefined);
    const onRemoved = await open();
    await vi.waitFor(() => expect(listed()).toEqual(['marie', 'yann']));
    await remove('marie');
    expect(removePostRepost).toHaveBeenCalledWith('p1', 'marie');
    expect(listed()).toEqual(['yann']);
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it('a repost already gone is what the tap asked for: the row stays off', async () => {
    listPostReposters.mockResolvedValue([row('marie')]);
    removePostRepost.mockRejectedValue(
      new ApiRefusalError(404, 'MEMBER_REPOST_NOT_LISTED', 'Repost not found')
    );
    const onRemoved = await open();
    await vi.waitFor(() => expect(listed()).toEqual(['marie']));
    await remove('marie');
    expect(listed()).toEqual([]);
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it('a refused removal puts the row back', async () => {
    listPostReposters.mockResolvedValue([row('marie')]);
    removePostRepost.mockRejectedValue(new Error('offline'));
    const onRemoved = await open();
    await vi.waitFor(() => expect(listed()).toEqual(['marie']));
    await remove('marie');
    await vi.waitFor(() => expect(listed()).toEqual(['marie']));
    expect(onRemoved).not.toHaveBeenCalled();
  });
});
