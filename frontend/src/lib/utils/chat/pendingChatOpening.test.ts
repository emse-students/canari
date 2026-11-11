/**
 * A PROFILE'S "MESSAGE" OPENS THE DM WITH THAT PERSON - EXISTING, LATE, OR NEW.
 *
 * The button handed the chat page the person's USER id as if it were a conversation key; no
 * conversation is keyed by a user id, so the selection was dropped in the same frame and nothing
 * opened, whether a DM existed or not. These cases drive the whole path from the button's write to
 * the selection, through the real `startNewConversation` that finds or creates the DM.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: {
    isMessageCatchupActive: false,
    resetMessageCatchupState: vi.fn(),
  },
}));

vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));

import { startNewConversation } from './groupCreation';
import {
  landPendingChatOpening,
  requestDirectConversationWith,
  type OpeningStorage,
} from './pendingChatOpening';
import { PENDING_CONTACT_KEY } from './selectionAcrossReload';

const PEER = 'b3c1f0aa-0000-4000-8000-00000000beef';

/** A sessionStorage stand-in: the opening only ever reads, writes and removes. */
function memoryStorage(): OpeningStorage & { size: () => number } {
  const items = new Map<string, string>();
  return {
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, v),
    removeItem: (k) => void items.delete(k),
    size: () => items.size,
  };
}

/** The chat page around the opening: a map, a selection, and the real DM path with a fake MLS. */
function chatPage() {
  const local = new Set<string>();
  const conversations = new SvelteMap<string, Record<string, unknown>>();
  let settled = false;
  let selected: string | null = null;
  const mlsService = {
    getUserGroups: vi.fn(async () => []),
    fetchUserDevices: vi.fn(async (uid: string) =>
      uid === PEER ? [{ deviceId: 'peer-dev' }] : []
    ),
    getDeviceId: vi.fn(() => 'dev-1'),
    createRemoteGroup: vi.fn(async () => 'g-new-dm'),
    registerMember: vi.fn(async () => {}),
    createGroup: vi.fn(async (id: string) => {
      local.add(id);
    }),
    getLocalGroups: vi.fn(() => Array.from(local)),
    acquireAddLock: vi.fn(async () => true),
    acquireAddLockAnswer: vi.fn(async () => 'taken'),
    releaseAddLock: vi.fn(async () => {}),
    getGroupMemberIdentities: vi.fn(async () => [] as string[]),
    runUnderMlsLock: vi.fn((fn: () => Promise<unknown>) => fn()),
    addMembersBulk: vi.fn(async () => ({
      addedDeviceIds: ['peer-dev'],
      skipped: [],
      welcome: new Uint8Array([1]),
    })),
    sendWelcome: vi.fn(async () => {}),
    deleteGroupOnServer: vi.fn(async () => {}),
  };
  const selectConversation = (key: string) => {
    selected = key;
  };
  const storage = memoryStorage();
  const onRefused = vi.fn();
  const land = () =>
    landPendingChatOpening({
      storage,
      sourcesSettled: () => settled,
      hasConversation: (key) => conversations.has(key),
      selectConversation,
      startDirectConversation: (peerUserId) =>
        startNewConversation(peerUserId, {
          mlsService: mlsService as never,
          storage: null,
          userId: 'me-0000',
          deviceKeyB64: 'k',
          historyBaseUrl: 'https://example.invalid',
          conversations: conversations as never,
          selectConversation,
          saveConversation: async () => {},
          log: () => {},
        }),
      onRefused,
      log: () => {},
    });
  return {
    conversations,
    mlsService,
    storage,
    onRefused,
    land,
    settle: () => {
      settled = true;
    },
    selected: () => selected,
  };
}

/** A DM with the peer as the restore writes it: keyed by its GROUP id, the peer a field. */
function existingDm(page: ReturnType<typeof chatPage>) {
  page.conversations.set('g-existing-dm', {
    id: 'g-existing-dm',
    name: 'Peer',
    contactName: PEER,
    directPeerId: PEER,
    conversationType: 'direct',
    lifecycle: 'active',
    messages: [],
  });
}

describe("a profile's Message button", () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('opens the DM with that person when the device holds one', async () => {
    const page = chatPage();
    existingDm(page);
    page.settle();

    requestDirectConversationWith(PEER, page.storage);
    await page.land();

    // The DM's KEY is selected, never the person's id.
    expect(page.selected()).toBe('g-existing-dm');
    expect(page.mlsService.createRemoteGroup).not.toHaveBeenCalled();
    expect(page.storage.size()).toBe(0);
  });

  it('waits for the restore when pressed before the map holds the DM, then opens it', async () => {
    const page = chatPage();
    requestDirectConversationWith(PEER, page.storage);

    // The map is not authoritative yet: nothing is selected, nothing created, nothing consumed.
    expect(await page.land()).toBeNull();
    expect(page.selected()).toBeNull();
    expect(page.storage.size()).toBe(1);

    existingDm(page);
    page.settle();
    await page.land();

    expect(page.selected()).toBe('g-existing-dm');
    expect(page.mlsService.createRemoteGroup).not.toHaveBeenCalled();
  });

  it('creates and opens a new DM when there is none', async () => {
    const page = chatPage();
    page.settle();

    requestDirectConversationWith(PEER, page.storage);
    await page.land();

    expect(page.mlsService.createRemoteGroup).toHaveBeenCalledTimes(1);
    expect(page.selected()).toBe('g-new-dm');
    expect(page.conversations.has('g-new-dm')).toBe(true);
    expect(page.onRefused).not.toHaveBeenCalled();
  });

  it('tells the reader when the DM cannot be opened, rather than doing nothing', async () => {
    const page = chatPage();
    page.mlsService.fetchUserDevices = vi.fn(async () => []);
    page.settle();

    requestDirectConversationWith(PEER, page.storage);
    await page.land();

    expect(page.onRefused).toHaveBeenCalledWith('peer-has-no-device');
    expect(page.selected()).toBeNull();
  });
});

describe('a conversation asked by key (mini panel, multi-tab reload)', () => {
  it('is selected once the map is settled', async () => {
    const page = chatPage();
    existingDm(page);
    page.storage.setItem(PENDING_CONTACT_KEY, 'g-existing-dm');

    expect(await page.land()).toBeNull();
    expect(page.selected()).toBeNull();

    page.settle();
    await page.land();
    expect(page.selected()).toBe('g-existing-dm');
  });
});
