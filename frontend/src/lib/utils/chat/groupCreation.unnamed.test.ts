/**
 * A group created without a name tells the server none and stores none: every device draws it by
 * its members' first names (owner, 2026-11-17; docs/wiki/frontend/modules/chat.md#one-new-discussion-panel).
 */
import { describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: {
    isMessageCatchupActive: false,
    resetMessageCatchupState: vi.fn(),
  },
}));

import { createNewGroup } from './groupCreation';
import type { Conversation } from '$lib/types';

function deps(conversations = new SvelteMap<string, Conversation>()) {
  const local = new Set<string>();
  const mlsService = {
    createRemoteGroup: vi.fn(async (_name: string | null) => 'g-new'),
    registerMember: vi.fn(async () => {}),
    createGroup: vi.fn(async (id: string) => {
      local.add(id);
    }),
    fetchUserDevices: vi.fn(async () => []),
    getDeviceId: vi.fn(() => 'dev-1'),
    getLocalGroups: vi.fn(() => Array.from(local)),
    deleteGroupOnServer: vi.fn(async () => {}),
  };
  return {
    mlsService,
    conversations,
    args: {
      mlsService: mlsService as never,
      storage: null,
      userId: 'me',
      deviceKeyB64: 'k',
      historyBaseUrl: 'https://example.invalid',
      conversations,
      selectConversation: vi.fn(),
      saveConversation: vi.fn(async () => {}),
      log: vi.fn(),
    },
  };
}

describe('an unnamed group', () => {
  it('sends no name to the server and stores none', async () => {
    const d = deps();
    const outcome = await createNewGroup('   ', d.args);

    expect(outcome).toEqual({ ok: true, key: 'g-new' });
    expect(d.mlsService.createRemoteGroup).toHaveBeenCalledWith(null, true);
    expect(d.conversations.get('g-new')?.name).toBe('');
  });

  it('is never refused as a duplicate of another unnamed group', async () => {
    const d = deps();
    d.conversations.set('g-old', {
      id: 'g-old',
      name: '',
      contactName: '',
      conversationType: 'group',
    } as Conversation);
    const outcome = await createNewGroup('', d.args);
    expect(outcome.ok).toBe(true);
  });

  it('still refuses a NAMED group whose name is taken', async () => {
    const d = deps();
    d.conversations.set('g-old', {
      id: 'g-old',
      name: 'Equipe',
      contactName: 'Equipe',
      conversationType: 'group',
    } as Conversation);
    expect(await createNewGroup('equipe', d.args)).toEqual({
      ok: false,
      reason: 'duplicate-group-name',
    });
    expect(d.mlsService.createRemoteGroup).not.toHaveBeenCalled();
  });
});
