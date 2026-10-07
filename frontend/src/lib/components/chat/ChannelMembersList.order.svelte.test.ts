/**
 * THE RENDERED MEMBER LIST READS BY FAMILY NAME, IN EACH SECTION (user, 2026-10-05).
 *
 * The pure order is pinned in `familyNameOrder.test.ts` and the freeze in
 * `memberOrder.svelte.test.ts`; this mounts a real member list so the wiring - the rows rendered
 * from the ordered ids, not from the server's order - is asserted too. The order is read from the
 * profile links, which carry the id whatever name has or has not resolved yet.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { writable } from 'svelte/store';

const profiles: Record<string, { firstName: string; lastName: string }> = {
  hugo: { firstName: 'Hugo', lastName: 'VIENNE' },
  maxime: { firstName: 'Maxime', lastName: 'BASEL' },
  melvin: { firstName: 'Melvin', lastName: 'BRETON--DESCHAMPS' },
  gabriel: { firstName: 'Gabriel', lastName: 'DUPONT' },
  anne: { firstName: 'Anne', lastName: 'Zola' },
  bob: { firstName: 'Bob', lastName: 'Abel' },
};

vi.mock('$lib/stores/user', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/user')>()),
  fetchUserProfile: async (id: string) => ({
    id,
    displayName: null,
    promo: null,
    formation: null,
    avatarMediaId: null,
    bio: null,
    ...profiles[id],
  }),
}));

// The avatar would fetch its image from a server this suite does not run; it renders nothing here.
vi.mock('$lib/components/shared/Avatar.svelte', () => ({ default: () => {} }));

vi.mock('$lib/stores/presenceStore', () => ({
  presenceMap: writable({}),
  watchUsers: () => {},
  unwatchUsers: () => {},
}));

vi.mock('$lib/services/ChannelService', () => ({
  channelService: {
    // The server's order, deliberately not alphabetical in either section.
    listMembers: async () => [
      { id: 'm1', userId: 'hugo', role: 'member', joinedAt: '' },
      { id: 'm2', userId: 'anne', role: 'admin', joinedAt: '' },
      { id: 'm3', userId: 'gabriel', role: 'member', joinedAt: '' },
      { id: 'm4', userId: 'melvin', role: 'member', joinedAt: '' },
      { id: 'm5', userId: 'bob', role: 'moderator', joinedAt: '' },
      { id: 'm6', userId: 'maxime', role: 'member', joinedAt: '' },
    ],
  },
}));

const { flushSync, mount, unmount } = await import('svelte');
const { default: ChannelMembersList } = await import('./ChannelMembersList.svelte');

let app: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  document.body.innerHTML = '';
});

describe('ChannelMembersList order', () => {
  it('renders admins, then members, each by family name', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    app = mount(ChannelMembersList, { target, props: { selectedChannelId: 'c1' } });
    flushSync();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    flushSync();

    const ids = [...target.querySelectorAll('a[href^="/profile/"]')].map((a) =>
      decodeURIComponent(a.getAttribute('href')!.slice('/profile/'.length))
    );
    expect(ids).toEqual(['bob', 'anne', 'maxime', 'melvin', 'gabriel', 'hugo']);
  });
});
