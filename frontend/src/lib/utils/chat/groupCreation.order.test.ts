import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: {
    isMessageCatchupActive: false,
    resetMessageCatchupState: vi.fn(),
  },
}));

vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));

import { createNewGroup, startNewConversation } from './groupCreation';
import { SvelteMap } from 'svelte/reactivity';
import type { IMlsService } from '$lib/mls-client/IMlsService';

/** What `addMembersBulk` resolves to, so a mock and its per-test override share one type. */
type BulkAddResult = Awaited<ReturnType<IMlsService['addMembersBulk']>>;

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

/**
 * The DM path owes the SAME invariant, and did not honour it - which is the whole reason this
 * block exists rather than a third case above.
 *
 * `startNewConversation` published the conversation row (and selected it) immediately after
 * `createRemoteGroup`, before `registerMember` had written the roster row. A direct conversation is
 * keyed by its groupId, and the SYNC_WATCHDOG treats every key in `conversations` as a group to
 * recover, every 5 s - so for the length of two network calls the brand-new group was a recovery
 * candidate whose own creator the server would answer 403, because `dm_group_members` was still
 * empty. `requestReAdd` classifies that refusal as `NotAGroupMemberError`, a TERMINATING answer,
 * and retires the conversation: "this conversation has been deleted", over a group created seconds
 * earlier. Reported from production on 2026-09-01 (group `ab47add3`), where the message the creator
 * typed was delivered to the peer normally - the retire simply landed after the activation.
 *
 * The row is therefore written ONCE, at the end, after the local-state check. A field written once
 * cannot lose a race for it.
 */
function dmDeps() {
  const order: string[] = [];
  const local = new Set<string>();
  // Typed like the rows the code under test writes: the assertions read `lifecycle` off whatever
  // the map holds, and an untyped map makes every one of those reads an error.
  const conversations = new SvelteMap<string, { lifecycle?: string }>();
  /** Every mutation of the map, in order, so the test can assert on what existed WHEN. */
  const published: { at: string; lifecycle: unknown }[] = [];
  const note = (at: string) => order.push(at);

  const mlsService = {
    getUserGroups: vi.fn(async () => []),
    fetchUserDevices: vi.fn(async (uid: string) =>
      uid === 'peer' ? [{ deviceId: 'peer-dev' }] : []
    ),
    getDeviceId: vi.fn(() => 'dev-1'),
    createRemoteGroup: vi.fn(async () => {
      note('createRemoteGroup');
      return 'g-dm';
    }),
    registerMember: vi.fn(async () => {
      note('registerMember');
      published.push({ at: 'registerMember', lifecycle: conversations.get('g-dm')?.lifecycle });
    }),
    createGroup: vi.fn(async (id: string) => {
      note('createGroup');
      local.add(id);
      published.push({ at: 'createGroup', lifecycle: conversations.get('g-dm')?.lifecycle });
    }),
    getLocalGroups: vi.fn(() => Array.from(local)),
    acquireAddLock: vi.fn(async () => true),
    releaseAddLock: vi.fn(async () => {}),
    // Annotated to `IMlsService`'s own shape rather than inferred from this one happy answer: a
    // test below replaces the mock with the empty result, which an inferred `welcome: Uint8Array`
    // would refuse.
    addMembersBulk: vi.fn(async (): Promise<BulkAddResult> => ({
      addedDeviceIds: ['peer-dev'],
      skippedDeviceIds: [],
      welcome: new Uint8Array([1]),
    })),
    sendWelcome: vi.fn(async () => {}),
    saveState: vi.fn(async () => new Uint8Array([1])),
    deleteGroupOnServer: vi.fn(async () => {}),
  };

  return {
    order,
    local,
    published,
    mlsService,
    args: {
      mlsService: mlsService as never,
      storage: null,
      userId: 'me',
      deviceKeyB64: 'k',
      historyBaseUrl: 'https://example.invalid',
      conversations,
      selectConversation: vi.fn(() => note('selectConversation')),
      saveConversation: vi.fn(async () => {}),
      log: vi.fn(),
    },
  };
}

describe('startNewConversation - a new DM must not be recoverable before it is registered', () => {
  it('publishes no conversation row before the server names us a member', async () => {
    const d = dmDeps();

    await startNewConversation('peer', d.args as never);

    // The watchdog reads this map by key. Nothing may be in it while the roster row is missing.
    expect(d.published.find((p) => p.at === 'registerMember')?.lifecycle).toBeUndefined();
    expect(d.published.find((p) => p.at === 'createGroup')?.lifecycle).toBeUndefined();
  });

  it('registers the membership before the local MLS group exists', async () => {
    const d = dmDeps();

    await startNewConversation('peer', d.args as never);

    expect(d.order.indexOf('registerMember')).toBeLessThan(d.order.indexOf('createGroup'));
  });

  it('publishes the row exactly once, already active, and only at the end', async () => {
    const d = dmDeps();

    await startNewConversation('peer', d.args as never);

    const convo = d.args.conversations.get('g-dm');
    expect(convo?.lifecycle).toBe('active');
    // Selection is part of presenting the conversation, so it moves with it.
    expect(d.order.indexOf('selectConversation')).toBeGreaterThan(d.order.indexOf('createGroup'));
  });

  it('presents nothing when the local MLS state vanished during creation', async () => {
    const d = dmDeps();
    d.mlsService.addMembersBulk = vi.fn(async () => {
      d.local.delete('g-dm');
      return { addedDeviceIds: [], skippedDeviceIds: [], welcome: undefined };
    });

    await startNewConversation('peer', d.args as never);

    expect(d.args.conversations.size).toBe(0);
    expect(d.mlsService.deleteGroupOnServer).toHaveBeenCalledWith('g-dm');
  });
});
