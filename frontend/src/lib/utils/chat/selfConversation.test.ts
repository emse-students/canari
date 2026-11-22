/**
 * "MES NOTES" - the account's conversation with itself (owner, 2026-11-22; server `dm_groups.kind =
 * 'self'`, migration 056). An MLS group whose only members are this account's devices: it has no
 * peer, so every site that would hunt for one must be handed the server's `kind` and skip it, and
 * its row must say what it is across a reload because neither its name nor its roster can.
 * docs/wiki/frontend/modules/chat.md#mes-notes---the-conversation-with-oneself-2026-11-22
 */
import { describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: {
    isMessageCatchupActive: false,
    resetMessageCatchupState: vi.fn(),
  },
}));

import type { Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import { SelfConversationExistsError } from '$lib/mls-client/mlsDeliveryApi';
import { m } from '$lib/paraglide/messages';
import {
  buildConversationRow,
  findSelfConversation,
  resolveConversationListPresentation,
  restoredConversationRow,
  selfConversationIdentity,
  toConversationMeta,
} from './conversations';
import { ensureConversationForServerGroup } from './serverGroupConversation';
import { createSelfConversation } from './groupCreation';

const ME = 'a1'.repeat(32);
const SELF_GROUP = 'e4c1f0aa-0000-4000-8000-00000000005e';

function selfRow(over: Partial<Conversation> = {}): Conversation {
  return {
    ...buildConversationRow({
      id: SELF_GROUP,
      lifecycle: 'active',
      identity: selfConversationIdentity(),
    }),
    ...over,
  };
}

describe('the row of "Mes notes"', () => {
  it('names no peer, ever', () => {
    const row = selfRow();
    expect(row.conversationType).toBe('self');
    expect(row).not.toHaveProperty('directPeerId');
  });

  it('is stored with its kind, and restored as itself - never re-read from its name', () => {
    const meta = toConversationMeta(SELF_GROUP, selfRow({ lastMessageAt: 42 }), ME);
    expect(meta.kind).toBe('self');

    // A legacy 1:1 with a malformed self-only name parses as nothing useful; the kind decides.
    const restored = restoredConversationRow({ ...meta, name: `${ME}::${ME}` }, ME);
    expect(restored.conversationType).toBe('self');
    expect(restored).not.toHaveProperty('directPeerId');
    expect(restored.lastMessageAt).toBe(42);
  });

  it('an ordinary row is stored with no kind', () => {
    const group = buildConversationRow({
      id: 'g1',
      lifecycle: 'active',
      identity: { conversationType: 'group', contactName: 'Club', displayName: 'Club' },
    });
    expect(toConversationMeta('g1', group, ME)).not.toHaveProperty('kind');
  });

  it("is drawn with the reader's own label", () => {
    const pres = resolveConversationListPresentation(
      { id: SELF_GROUP, name: '', contactName: '', conversationType: 'self' },
      ME
    );
    expect(pres).toEqual({
      conversationType: 'self',
      contactId: SELF_GROUP,
      displayName: m.conversation_self_title(),
      displayNameResolved: true,
    });
  });

  it('is found live, and a tombstone is not it', () => {
    const live = new Map([[SELF_GROUP, selfRow()]]);
    expect(findSelfConversation(live)?.[0]).toBe(SELF_GROUP);
    const dead = new Map([[SELF_GROUP, selfRow({ lifecycle: 'removed' })]]);
    expect(findSelfConversation(dead)).toBeNull();
  });
});

describe('discovery of a self group the server lists', () => {
  it('builds the self row without asking the roster for a peer', async () => {
    const conversations = new Map<string, Conversation>();
    const getGroupUserMembers = vi.fn(async () => [{ userId: ME }]);
    const notifyConversationAvailable = vi.fn();
    const outcome = await ensureConversationForServerGroup(
      { groupId: SELF_GROUP, name: null, isGroup: false, kind: 'self' },
      {
        mlsService: {
          getGroupUserMembers,
          notifyConversationAvailable,
          getLocalGroups: () => [],
        } as unknown as IMlsService,
        userId: ME,
        conversations,
        saveConversation: vi.fn(async () => {}),
        owedExits: new Set<string>(),
        log: vi.fn(),
      }
    );

    expect(outcome).toBe('created');
    expect(getGroupUserMembers).not.toHaveBeenCalled();
    expect(conversations.get(SELF_GROUP)).toMatchObject({
      conversationType: 'self',
      lifecycle: 'pending',
    });
    expect(conversations.get(SELF_GROUP)).not.toHaveProperty('directPeerId');
  });

  it('the same row WITHOUT the kind (a server before 056) is a 1:1 with no peer, and skipped', async () => {
    const conversations = new Map<string, Conversation>();
    const outcome = await ensureConversationForServerGroup(
      { groupId: SELF_GROUP, name: null, isGroup: false },
      {
        mlsService: {
          getGroupUserMembers: vi.fn(async () => [{ userId: ME }]),
          getLocalGroups: () => [],
        } as unknown as IMlsService,
        userId: ME,
        conversations,
        saveConversation: vi.fn(async () => {}),
        owedExits: new Set<string>(),
        log: vi.fn(),
      }
    );
    expect(outcome).toBe('peer-unresolved');
    expect(conversations.size).toBe(0);
  });
});

describe('opening "Mes notes"', () => {
  function deps(conversations = new SvelteMap<string, Conversation>()) {
    const local = new Set<string>();
    const mlsService = {
      createRemoteGroup: vi.fn(async () => SELF_GROUP),
      registerMember: vi.fn(async () => {}),
      createGroup: vi.fn(async (id: string) => {
        local.add(id);
      }),
      fetchUserDevices: vi.fn(async () => []),
      getDeviceId: vi.fn(() => 'dev-1'),
      getLocalGroups: vi.fn(() => Array.from(local)),
      deleteGroupOnServer: vi.fn(async () => {}),
    };
    const selectConversation = vi.fn();
    return {
      mlsService,
      conversations,
      selectConversation,
      args: {
        mlsService: mlsService as never,
        storage: null,
        userId: ME,
        deviceKeyB64: 'k',
        historyBaseUrl: 'https://example.invalid',
        conversations,
        selectConversation,
        saveConversation: vi.fn(async () => {}),
        log: vi.fn(),
      },
    };
  }

  it('creates it the first time: a self group, no name, opened, its row typed self', async () => {
    const d = deps();
    expect(await createSelfConversation(d.args)).toEqual({ ok: true, key: SELF_GROUP });

    expect(d.mlsService.createRemoteGroup).toHaveBeenCalledWith(null, false, 'self');
    expect(d.mlsService.registerMember).toHaveBeenCalledWith(SELF_GROUP, ME);
    expect(d.conversations.get(SELF_GROUP)?.conversationType).toBe('self');
    expect(d.selectConversation).toHaveBeenCalledWith(SELF_GROUP);
  });

  it('opens the one it holds and creates nothing', async () => {
    const d = deps(new SvelteMap([[SELF_GROUP, selfRow()]]));
    expect(await createSelfConversation(d.args)).toEqual({ ok: true, key: SELF_GROUP });
    expect(d.mlsService.createRemoteGroup).not.toHaveBeenCalled();
    expect(d.selectConversation).toHaveBeenCalledWith(SELF_GROUP);
  });

  it('another device already holds it: refused as arriving, and nothing is deleted server-side', async () => {
    const d = deps();
    d.mlsService.createRemoteGroup.mockRejectedValueOnce(
      new SelfConversationExistsError('f00dfeed-0000-4000-8000-000000000001')
    );

    expect(await createSelfConversation(d.args)).toEqual({
      ok: false,
      reason: 'self-conversation-arriving',
    });
    expect(d.mlsService.createGroup).not.toHaveBeenCalled();
    expect(d.mlsService.deleteGroupOnServer).not.toHaveBeenCalled();
    expect(d.conversations.size).toBe(0);
  });
});
