import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: {
    isMessageCatchupActive: false,
    resetMessageCatchupState: vi.fn(),
  },
}));

import { createNewGroup } from './groupCreation';
import { SvelteMap } from 'svelte/reactivity';

/**
 * The two invariants that keep a newly created group REACHABLE, both measured into existence by
 * HEAL-REVOKE-7 on 2026-08-30.
 *
 * A group was forgotten 291 ms after it was created, by a sweep running concurrently, and the
 * creation then announced success over state that no longer existed. Its creator answered
 * `welcome_request` with `Group not found` for the next twenty minutes and no member could ever
 * join. The sweep's own ordering is fixed in `initializeConnection` and guarded by its own test;
 * these two are the creation side, and neither is about timing:
 *
 *  1. the server must name the group before this device holds it locally, so that "present in
 *     `getLocalGroups()`" implies "listed by `getUserGroups`" for every reader, for ever;
 *  2. a group whose local state is gone is not a created group, whatever else succeeded.
 */
function deps(overrides: Record<string, unknown> = {}) {
  const order: string[] = [];
  const local = new Set<string>();
  const mlsService = {
    createRemoteGroup: vi.fn(async () => {
      order.push('createRemoteGroup');
      return 'g-new';
    }),
    registerMember: vi.fn(async () => {
      order.push('registerMember');
    }),
    createGroup: vi.fn(async (id: string) => {
      order.push('createGroup');
      local.add(id);
    }),
    fetchUserDevices: vi.fn(async () => []),
    getDeviceId: vi.fn(() => 'dev-1'),
    getLocalGroups: vi.fn(() => Array.from(local)),
    saveState: vi.fn(async () => new Uint8Array([1])),
    deleteGroupOnServer: vi.fn(async () => {
      order.push('deleteGroupOnServer');
    }),
    ...overrides,
  };
  return {
    order,
    local,
    mlsService,
    args: {
      mlsService: mlsService as never,
      storage: null,
      userId: 'u1',
      deviceKeyB64: 'k',
      historyBaseUrl: 'https://example.invalid',
      conversations: new SvelteMap(),
      selectConversation: vi.fn(),
      saveConversation: vi.fn(async () => {}),
      log: vi.fn(),
    },
  };
}

describe('createNewGroup - a created group must be reachable', () => {
  it('registers the membership BEFORE the local MLS group exists', async () => {
    const d = deps();

    await createNewGroup('Equipe', d.args as never);

    // The server list answers from `dm_group_members`, which `registerMember` writes. Creating the
    // local group first leaves an interval in which the group exists here and cannot be named
    // there - which is exactly the shape every destructive sweep reads as a dead group.
    expect(d.order.indexOf('registerMember')).toBeLessThan(d.order.indexOf('createGroup'));
    expect(d.mlsService.createGroup).toHaveBeenCalledWith('g-new');
  });

  it('refuses to announce a group whose local MLS state disappeared during creation', async () => {
    // Exactly what the concurrent sweep did: the state is dropped while creation is in flight.
    const d = deps();
    d.mlsService.fetchUserDevices = vi.fn(async () => {
      d.local.delete('g-new');
      return [];
    });

    await createNewGroup('Equipe', d.args as never);

    // No conversation is presented...
    expect(d.args.conversations.size).toBe(0);
    expect(d.args.selectConversation).not.toHaveBeenCalled();
    // ...and the orphan the server would otherwise keep is cleaned up.
    expect(d.mlsService.deleteGroupOnServer).toHaveBeenCalledWith('g-new');
  });

  it('still presents a group whose creation actually succeeded', async () => {
    const d = deps();

    await createNewGroup('Equipe', d.args as never);

    expect(d.args.conversations.size).toBe(1);
    expect(d.mlsService.deleteGroupOnServer).not.toHaveBeenCalled();
  });
});
