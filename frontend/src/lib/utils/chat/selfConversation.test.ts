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
import {
  SelfConversationExistsError,
  SelfConversationUnsupportedError,
} from '$lib/mls-client/mlsDeliveryApi';
import { m } from '$lib/paraglide/messages';
import {
  buildConversationRow,
  findSelfConversation,
  retaggedAsSelf,
  resolveConversationListPresentation,
  restoredConversationRow,
  selfConversationIdentity,
  toConversationMeta,
} from './conversations';
import { ensureConversationForServerGroup } from './serverGroupConversation';
import { createSelfConversation, devicesKnowingSelf } from './groupCreation';
import { readSelfConversationDeviceCover } from './selfConversationLossNotice';

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

  it('a row this device holds under another type is re-typed as "Mes notes", its messages kept', async () => {
    // Built from a Welcome while the group read failed: an ordinary group row.
    const asGroup = buildConversationRow({
      id: SELF_GROUP,
      lifecycle: 'active',
      identity: { conversationType: 'group', contactName: ME, displayName: ME },
    });
    asGroup.messages = [{ id: 'm1' } as Conversation['messages'][number]];
    const conversations = new Map<string, Conversation>([[SELF_GROUP, asGroup]]);
    const saveConversation = vi.fn(async () => {});

    const outcome = await ensureConversationForServerGroup(
      { groupId: SELF_GROUP, name: null, isGroup: false, kind: 'self' },
      {
        mlsService: { getLocalGroups: () => [SELF_GROUP] } as unknown as IMlsService,
        userId: ME,
        conversations,
        saveConversation,
        owedExits: new Set<string>(),
        log: vi.fn(),
      }
    );

    expect(outcome).toBe('existed');
    expect(conversations.get(SELF_GROUP)?.conversationType).toBe('self');
    expect(conversations.get(SELF_GROUP)?.messages).toHaveLength(1);
    expect(saveConversation).toHaveBeenCalledWith(SELF_GROUP);
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

    expect(d.mlsService.createRemoteGroup).toHaveBeenCalledWith(null, false, 'self', {
      replaceUnheld: false,
    });
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
      new SelfConversationExistsError('f00dfeed-0000-4000-8000-000000000001', 1)
    );

    expect(await createSelfConversation(d.args)).toEqual({
      ok: false,
      reason: 'self-conversation-arriving',
    });
    expect(d.mlsService.createRemoteGroup).toHaveBeenCalledTimes(1);
    expect(d.mlsService.createGroup).not.toHaveBeenCalled();
    expect(d.mlsService.deleteGroupOnServer).not.toHaveBeenCalled();
    expect(d.conversations.size).toBe(0);
  });

  it("the live one is THIS device's: its row is put right and opened, nothing created", async () => {
    const d = deps();
    d.mlsService.createGroup(SELF_GROUP);
    d.mlsService.createGroup.mockClear();
    d.mlsService.createRemoteGroup.mockRejectedValueOnce(
      new SelfConversationExistsError(SELF_GROUP, 0)
    );

    expect(await createSelfConversation(d.args)).toEqual({ ok: true, key: SELF_GROUP });
    expect(d.mlsService.createRemoteGroup).toHaveBeenCalledTimes(1);
    expect(d.mlsService.createGroup).not.toHaveBeenCalled();
    expect(d.conversations.get(SELF_GROUP)?.conversationType).toBe('self');
    expect(d.selectConversation).toHaveBeenCalledWith(SELF_GROUP);
  });

  it('nobody holds the live one: the server is asked ONCE to replace it, and the new one opens', async () => {
    const d = deps();
    d.mlsService.createRemoteGroup.mockRejectedValueOnce(
      new SelfConversationExistsError('f00dfeed-0000-4000-8000-000000000001', 0)
    );

    expect(await createSelfConversation(d.args)).toEqual({ ok: true, key: SELF_GROUP });
    expect(d.mlsService.createRemoteGroup).toHaveBeenNthCalledWith(1, null, false, 'self', {
      replaceUnheld: false,
    });
    expect(d.mlsService.createRemoteGroup).toHaveBeenNthCalledWith(2, null, false, 'self', {
      replaceUnheld: true,
    });
    expect(d.conversations.get(SELF_GROUP)?.conversationType).toBe('self');
  });

  it('a server that does not know the kind: its ordinary group is deleted as such, and the creation refused', async () => {
    const d = deps();
    const ORDINARY = 'f00dfeed-0000-4000-8000-0000000000aa';
    d.mlsService.createRemoteGroup.mockRejectedValueOnce(
      new SelfConversationUnsupportedError(ORDINARY)
    );

    expect(await createSelfConversation(d.args)).toEqual({
      ok: false,
      reason: 'self-conversation-unsupported',
    });
    // No `?kind=self`: that server does not read it, and the group it wrote is an ordinary one.
    expect(d.mlsService.deleteGroupOnServer).toHaveBeenCalledWith(ORDINARY);
    expect(d.mlsService.registerMember).not.toHaveBeenCalled();
    expect(d.mlsService.createGroup).not.toHaveBeenCalled();
    expect(d.mlsService.createRemoteGroup).toHaveBeenCalledTimes(1);
    expect(d.conversations.size).toBe(0);
    expect(d.selectConversation).not.toHaveBeenCalled();
  });

  it('a replacement the server still refuses (a device was admitted meanwhile) is arriving, not a loop', async () => {
    const d = deps();
    d.mlsService.createRemoteGroup
      .mockRejectedValueOnce(new SelfConversationExistsError(SELF_GROUP, 0))
      .mockRejectedValueOnce(new SelfConversationExistsError(SELF_GROUP, 1));

    expect(await createSelfConversation(d.args)).toEqual({
      ok: false,
      reason: 'self-conversation-arriving',
    });
    expect(d.mlsService.createRemoteGroup).toHaveBeenCalledTimes(2);
  });
});

describe('which other devices "Mes notes" is given', () => {
  it('only those whose build stated the capability', () => {
    expect(
      devicesKnowingSelf([
        { deviceId: 'new', selfConversationVersion: 1 },
        { deviceId: 'old', selfConversationVersion: 0 },
      ]).map((d) => d.deviceId)
    ).toEqual(['new']);
  });

  it('a re-typed row keeps what it carried', () => {
    const row = retaggedAsSelf(
      buildConversationRow({
        id: SELF_GROUP,
        lifecycle: 'active',
        identity: { conversationType: 'group', contactName: '', displayName: 'x' },
        lastMessageAt: 7,
      })
    );
    expect(row.conversationType).toBe('self');
    expect(row.lastMessageAt).toBe(7);
  });
});

describe('the loss notice of "Mes notes"', () => {
  const dev = (deviceId: string, selfConversationVersion = 1) => ({
    deviceId,
    selfConversationVersion,
  });
  const cover = (devices: ReturnType<typeof dev>[], seated: string[]) =>
    readSelfConversationDeviceCover({
      listDevices: async () => devices,
      listSeatedDevices: async () => seated.map((deviceId) => ({ deviceId })),
    });

  it('speaks while one device holds the notes, not once two do', async () => {
    expect(await cover([dev('a')], ['a'])).toBe('single');
    expect(await cover([dev('a'), dev('b')], ['a', 'b'])).toBe('several');
  });

  it('a second device whose build does not know "Mes notes" is no copy', async () => {
    expect(await cover([dev('a'), dev('old', 0)], ['a'])).toBe('single');
    // Even were it seated somehow, an older build reads the group as something it may delete.
    expect(await cover([dev('a'), dev('old', 0)], ['a', 'old'])).toBe('single');
  });

  it('a capable device not yet seated in the group is no copy either', async () => {
    expect(await cover([dev('a'), dev('b')], ['a'])).toBe('single');
  });

  it('a seat of a device no longer active is no copy', async () => {
    expect(await cover([dev('a')], ['a', 'revoked'])).toBe('single');
  });

  it('says nothing when either read fails - a failure is not an answer', async () => {
    expect(
      await readSelfConversationDeviceCover({
        listDevices: async () => {
          throw new Error('offline');
        },
        listSeatedDevices: async () => [],
      })
    ).toBe('unknown');
    expect(
      await readSelfConversationDeviceCover({
        listDevices: async () => [dev('a')],
        listSeatedDevices: async () => {
          throw new Error('offline');
        },
      })
    ).toBe('unknown');
  });
});
