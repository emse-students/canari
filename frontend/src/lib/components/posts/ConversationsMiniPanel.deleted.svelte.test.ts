// @vitest-environment happy-dom
/**
 * The posts page's conversation panel opens the SAVED user's store with no login. A kill between an
 * account deletion's marker and `clearAuth()` leaves the saved user naming the deleted account, and
 * opening its store would re-create `CanariDB_<id>` behind the owed wipe (review of #2023): an
 * account deleted from this device is never opened here.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

const getStorage = vi.fn(async (_uid: string) => ({ getConversations: async () => [] }));
vi.mock('$lib/db', () => ({ getStorage: (uid: string) => getStorage(uid) }));
vi.mock('$lib/stores/user', () => ({ getSavedUserId: () => 'user-x' }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: { userId: null, isLoggedIn: false },
  globalConvs: { conversations: new Map(), conversationsRestored: false },
}));

import ConversationsMiniPanel from './ConversationsMiniPanel.svelte';
import { markDeletedAccountWipePending } from '$lib/utils/deletedAccountMarker';

let mounted: Record<string, unknown> | null = null;

beforeEach(() => {
  localStorage.clear();
  getStorage.mockClear();
});

afterEach(() => {
  if (mounted) void unmount(mounted);
  mounted = null;
  localStorage.clear();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await tick();
}

it('opens the saved account store when nothing is owed for it', async () => {
  mounted = mount(ConversationsMiniPanel, { target: document.body });
  await settle();
  expect(getStorage).toHaveBeenCalledWith('user-x');
});

it('never opens the store of an account whose deletion wipe is owed', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  markDeletedAccountWipePending('user-x');
  mounted = mount(ConversationsMiniPanel, { target: document.body });
  await settle();
  expect(getStorage).not.toHaveBeenCalled();
});
