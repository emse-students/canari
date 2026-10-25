import { describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: {
    isMessageCatchupActive: false,
    resetMessageCatchupState: vi.fn(),
  },
}));

vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));

import { inviteMembersToGroup } from './groupCreation';

/**
 * The INVITE path owes the same ordering as creation: the server names a joiner BEFORE its Welcome
 * can arrive. Registering after delivery left an inviter dying between the two with a member in
 * the MLS tree that the delivery service did not know (backlog, measured 2026-09-05).
 */
function inviteDeps(registerImpl?: (u: string) => Promise<void>) {
  const order: string[] = [];
  const mlsService = {
    registerMember: vi.fn(async (_g: string, u: string) => {
      order.push(`register:${u}`);
      if (registerImpl) await registerImpl(u);
    }),
    fetchUserDevices: vi.fn(async (u: string) => [{ deviceId: `${u}-dev` }]),
    acquireAddLock: vi.fn(async () => true),
    releaseAddLock: vi.fn(async () => {}),
    // The tree the Add reads first (`addDevicesRebuildingOnRace`): nobody invited holds a leaf yet.
    getGroupMemberIdentities: vi.fn(async () => [] as string[]),
    addMembersBulk: vi.fn(async () => ({
      addedDeviceIds: ['bob-dev', 'carol-dev'],
      skipped: [],
      welcome: new Uint8Array([1]),
    })),
    sendWelcome: vi.fn(async (_w: unknown, owner: string) => {
      order.push(`welcome:${owner}`);
    }),
    sendMessage: vi.fn(async () => {}),
    getDeviceId: vi.fn(() => 'dev-1'),
  };
  return {
    order,
    mlsService,
    deps: {
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

const convo = { id: 'g1' } as never;

describe('inviteMembersToGroup - register before deliver', () => {
  it('registers every joiner before any Welcome is sent', async () => {
    const d = inviteDeps();
    await inviteMembersToGroup(['bob', 'carol'], convo, d.deps as never);

    const firstWelcome = d.order.findIndex((s) => s.startsWith('welcome:'));
    const lastRegister = d.order.map((s) => s.startsWith('register:')).lastIndexOf(true);
    expect(firstWelcome).toBeGreaterThan(-1);
    expect(lastRegister).toBeLessThan(firstWelcome);
  });

  it('withholds the Welcome from a user whose registration failed', async () => {
    const d = inviteDeps(async (u) => {
      if (u === 'carol') throw new Error('down');
    });
    await inviteMembersToGroup(['bob', 'carol'], convo, d.deps as never);

    expect(d.order).toContain('welcome:bob');
    expect(d.order).not.toContain('welcome:carol');
  });
});

/**
 * The invite NEVER THROWS, so its caller reads what it did: the answer to a join ask keeps the ask
 * on screen unless this says the person was added (`joinAnswers.ts`).
 */
describe('inviteMembersToGroup - says what it did', () => {
  it('answers `added` with the users whose devices the merged commit put in the tree', async () => {
    const d = inviteDeps();

    const outcome = await inviteMembersToGroup(['Bob', 'carol'], convo, d.deps as never);

    expect(outcome.kind).toBe('added');
    expect(outcome.kind === 'added' && [...outcome.addedUsers].sort()).toEqual(['bob', 'carol']);
  });

  it('answers `add-lock-busy` when another device holds the add lock, and stages nothing', async () => {
    const d = inviteDeps();
    d.mlsService.acquireAddLock = vi.fn(async () => false);

    const outcome = await inviteMembersToGroup(['bob'], convo, d.deps as never);

    expect(outcome).toEqual({ kind: 'not-added', reason: 'add-lock-busy' });
    expect(d.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });

  it('answers `no-device-added` when every key package was skipped', async () => {
    const d = inviteDeps();
    d.mlsService.addMembersBulk = vi.fn(async () => ({
      addedDeviceIds: [],
      skipped: [],
      welcome: new Uint8Array([1]),
    }));

    expect(await inviteMembersToGroup(['bob'], convo, d.deps as never)).toEqual({
      kind: 'not-added',
      reason: 'no-device-added',
    });
  });

  it('answers `failed` when the commit threw before it merged', async () => {
    const d = inviteDeps();
    d.mlsService.addMembersBulk = vi.fn(async () => {
      throw new Error('commit gate refused');
    });

    expect(await inviteMembersToGroup(['bob'], convo, d.deps as never)).toEqual({
      kind: 'not-added',
      reason: 'failed',
    });
  });
});
