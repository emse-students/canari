// @vitest-environment happy-dom
/**
 * "DELETE AND MUTE" ON A HIDDEN POST (1.7.1): the control is drawn from the server's answer alone
 * (`canMuteAuthor`, the rule the report queue follows), the mute runs FIRST, and a refused mute
 * stops the run - the post stays and the refusal is said, by its code. The handler used to swallow
 * the refusal in a bare `catch {}` and delete anyway: an institution moderator, who may mute
 * nobody, deleted the post and was told nothing while its writer stayed unmuted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { ModerationApiError } from '$lib/moderation/api';
import type { HiddenPost } from '$lib/posts/api';

vi.mock('$app/state', () => ({
  page: { url: new URL('https://canari.test/admin/moderation?tab=hidden'), params: {}, state: {} },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));
vi.mock('$lib/stores/auth', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/auth')>()),
  getToken: () => Promise.resolve('token'),
}));
vi.mock('$lib/stores/user', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/user')>()),
  isGlobalAdmin: () => true,
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => id,
  resolveUserDisplayName: (id: string) => Promise.resolve(id),
}));
vi.mock('$lib/components/shared/Avatar.svelte', () => ({ default: () => {} }));
vi.mock('$lib/live/api', async (orig) => ({
  ...(await orig<typeof import('$lib/live/api')>()),
  fetchWithdrawnBroadcasters: () => Promise.resolve([]),
}));
const api = vi.hoisted(() => ({
  listReports: vi.fn(),
  muteUser: vi.fn(),
  listHiddenPosts: vi.fn(),
  deletePost: vi.fn(),
}));
vi.mock('$lib/moderation/api', async (orig) => ({
  ...(await orig<typeof import('$lib/moderation/api')>()),
  listReports: api.listReports,
  muteUser: api.muteUser,
}));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  listHiddenPosts: api.listHiddenPosts,
  deletePost: api.deletePost,
}));

import Page from './+page.svelte';

function hidden(canMuteAuthor: boolean | undefined): HiddenPost {
  return {
    id: 'post-1',
    authorId: 'author-1',
    associationId: null,
    markdown: 'A hidden post body',
    createdAt: '2026-11-18T10:00:00.000Z',
    pendingReportCount: 0,
    canMuteAuthor,
  };
}

const mounted: (() => void)[] = [];
beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  api.listReports.mockResolvedValue([]);
  api.muteUser.mockReset();
  api.deletePost.mockReset();
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

async function openWith(post: HiddenPost) {
  api.listHiddenPosts.mockResolvedValue([post]);
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app));
  await vi.waitFor(() => expect(document.body.textContent).toContain('A hidden post body'));
  await settle();
}

const deleteAndMute = () =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === m.moderation_supprimer_muter()
  );

describe('Delete and mute on a hidden post', () => {
  it.each([false, undefined])('is not drawn when canMuteAuthor is %s', async (flag) => {
    await openWith(hidden(flag));
    expect(deleteAndMute()).toBeUndefined();
  });

  it('mutes the writer, then deletes the post', async () => {
    api.muteUser.mockResolvedValue({});
    api.deletePost.mockResolvedValue(undefined);
    await openWith(hidden(true));
    deleteAndMute()!.click();
    await vi.waitFor(() => expect(api.deletePost).toHaveBeenCalledWith('post-1'));
    expect(api.muteUser).toHaveBeenCalledWith('author-1');
  });

  it('a refused mute neither deletes nor stays silent', async () => {
    api.muteUser.mockRejectedValue(
      new ModerationApiError(403, 'MODERATION_OUTSIDE_OWN_INSTITUTION', 'moderation 403')
    );
    await openWith(hidden(true));
    deleteAndMute()!.click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(m.moderation_refusal_outside_own_institution())
    );
    expect(api.deletePost).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('A hidden post body');
  });

  it('a refused mute with no known code says the generic mute error and keeps the post', async () => {
    api.muteUser.mockRejectedValue(new TypeError('Failed to fetch'));
    await openWith(hidden(true));
    deleteAndMute()!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain(m.moderation_mute_error()));
    expect(api.deletePost).not.toHaveBeenCalled();
  });
});

describe('The hidden row names who spoke', () => {
  it('names the association first (database name) and the author second', async () => {
    await openWith({
      ...hidden(false),
      associationId: 'asso-1',
      associationName: 'Bureau des Eleves',
      associationLogoUrl: null,
    });
    const asso = document.querySelector('[data-hidden-association]')!;
    const author = document.querySelector('[data-hidden-author]')!;
    expect(asso.textContent).toContain('Bureau des Eleves');
    expect(asso.compareDocumentPosition(author) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names a personal post by its author alone', async () => {
    await openWith(hidden(false));
    expect(document.querySelector('[data-hidden-association]')).toBeNull();
    expect(document.querySelector('[data-hidden-author]')).not.toBeNull();
  });
});
