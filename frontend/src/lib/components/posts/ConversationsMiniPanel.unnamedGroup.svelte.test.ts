// @vitest-environment happy-dom
/**
 * An UNNAMED group in the posts mini panel reaches its members' first names. The stored baseline is
 * built before the tree is read, so it carries the generic word; feeding that word back as the live
 * row's fallback name froze the group at "Groupe" for the whole session (review of #3793).
 */
import { afterEach, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

const GROUP = vi.hoisted(() => '11111111-1111-4111-8111-111111111111');

vi.mock('$lib/utils/users/displayName', () => ({
  resolveUserDisplayName: vi.fn(async () => null),
  getUserDisplayNameSync: (id: string) => id,
  getUserFirstNameSync: (id: string, fallback: string) =>
    ({ alice: 'Alice', bob: 'Bob' })[id] ?? fallback,
  peekUserDisplayName: () => undefined,
}));
vi.mock('$lib/db', () => ({
  getStorage: async () => ({
    getConversations: async () => [
      { id: GROUP, name: GROUP, lifecycle: 'active', updatedAt: 1, awaitingAdmission: false },
    ],
  }),
}));
vi.mock('$lib/stores/user', () => ({ getSavedUserId: () => 'me' }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: { userId: 'me', isLoggedIn: true },
  globalConvs: {
    conversationsRestored: false,
    conversations: new Map([
      [
        GROUP,
        {
          id: GROUP,
          name: GROUP,
          contactName: GROUP,
          conversationType: 'group',
          lifecycle: 'active',
          messages: [],
        },
      ],
    ]),
  },
}));

import ConversationsMiniPanel from './ConversationsMiniPanel.svelte';
import { bindGroupTreeReader } from '$lib/utils/chat/groupTreeMembers';
import { m } from '$lib/paraglide/messages';

let mounted: Record<string, unknown> | null = null;

afterEach(() => {
  if (mounted) void unmount(mounted);
  mounted = null;
  bindGroupTreeReader(null);
});

it('draws an unnamed group by its members once the tree is read, never frozen at the generic word', async () => {
  // The tree is read only AFTER the stored baseline was built (the generic word), as at launch.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  bindGroupTreeReader({
    holds: () => true,
    read: async () => {
      await gate;
      return ['me:d1', 'alice:d1', 'bob:d1'];
    },
  });
  mounted = mount(ConversationsMiniPanel, { target: document.body });
  await vi.waitFor(async () => {
    await tick();
    expect(document.body.textContent).toContain(m.conversation_unnamed_group());
  });
  release();
  const expected = m.group_default_name_two({ first: 'Alice', second: 'Bob' });
  await vi.waitFor(async () => {
    await tick();
    expect(document.body.textContent).toContain(expected);
  });
  expect(document.body.textContent).not.toContain(m.conversation_unnamed_group());
});
