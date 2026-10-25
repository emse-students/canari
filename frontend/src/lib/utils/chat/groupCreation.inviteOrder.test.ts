import { describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: {
    isMessageCatchupActive: false,
    resetMessageCatchupState: vi.fn(),
  },
}));

vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));
// The acting device's own notice resolves names: a profile read nothing here is about.
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  resolveDisplayNames: async () => (id: string) => id,
}));

// The collector is pinned on its own (`strayLeaves.test.ts`); here only WHETHER it is handed the
// unadmitted people matters.
vi.mock('./strayLeaves', () => ({ takeBackUnadmittedLeaves: vi.fn(async () => true) }));

import { inviteMembersToGroup } from './groupCreation';
import { takeBackUnadmittedLeaves } from './strayLeaves';
import { MemberNotAdmittedError } from '$lib/mls-client/mlsDeliveryApi';

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
    // The invitation's baseline, read with the seat generation it is decided at.
    getGroupRosterAtGeneration: vi.fn(async () => ({
      members: [{ userId: 'u1' }],
      seatGeneration: 3,
    })),
    acquireAddLock: vi.fn(async () => true),
    releaseAddLock: vi.fn(async () => {}),
    // The tree the Add reads first (`addDevicesRebuildingOnRace`): nobody invited holds a leaf yet.
    getGroupMemberIdentities: vi.fn(async () => [] as string[]),
    // The Add reads its tree under the MLS lock (`readConfirmedTree`).
    runUnderMlsLock: vi.fn((fn: () => Promise<unknown>) => fn()),
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
      addMessageToChat: vi.fn(async () => {}),
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

/**
 * A DECLINE HOLDS AGAINST AN ADD DECIDED BEFORE IT (ADM-3). The commit is accepted - it may carry
 * other people - but the server admitted nobody it had ordered a Decline or a departure against, and
 * says so on the member-add call (`MemberNotAdmittedError`). That person gets no Welcome, is not
 * reported added, and the leaf the merged commit gave them is handed to the collector at once.
 */
describe('inviteMembersToGroup - a person the server did not admit', () => {
  it('withholds their Welcome, drops them from `added`, and takes their leaf back', async () => {
    vi.mocked(takeBackUnadmittedLeaves).mockClear();
    const d = inviteDeps(async (u) => {
      if (u === 'carol') throw new MemberNotAdmittedError('g1', 'carol');
    });

    const outcome = await inviteMembersToGroup(['bob', 'carol'], convo, d.deps as never);

    expect(d.order).toContain('welcome:bob');
    expect(d.order).not.toContain('welcome:carol');
    expect(outcome).toEqual({ kind: 'added', addedUsers: ['bob'] });
    expect(takeBackUnadmittedLeaves).toHaveBeenCalledExactlyOnceWith(
      d.mlsService,
      'g1',
      'u1',
      ['carol'],
      '[SYNC]',
      expect.any(Function)
    );
  });

  it('answers `removed-meanwhile` when nobody it named was admitted', async () => {
    vi.mocked(takeBackUnadmittedLeaves).mockClear();
    const d = inviteDeps(async (u) => {
      if (u !== 'u1') throw new MemberNotAdmittedError('g1', u);
    });

    expect(await inviteMembersToGroup(['bob', 'carol'], convo, d.deps as never)).toEqual({
      kind: 'not-added',
      reason: 'removed-meanwhile',
    });
    expect(d.order.some((s) => s.startsWith('welcome:'))).toBe(false);
  });

  it('sends the seat generation its roster was read at with the Add', async () => {
    const d = inviteDeps();
    await inviteMembersToGroup(['bob'], convo, d.deps as never);

    expect(d.mlsService.addMembersBulk.mock.calls[0]).toContainEqual(
      expect.objectContaining({ seatGeneration: 3 })
    );
  });
});

/**
 * AN ANSWER TO A JOIN ASK IS AN ANSWER TO THAT ASK. A Decline that settled it first removes the seat
 * (or a new ask replaces it under another identity): the Add stops before anything is staged.
 */
describe('inviteMembersToGroup - answering a join ask', () => {
  const answering = { userId: 'joe', askId: 'ask-1' };

  it('stages nothing when the ask it answers was declined first', async () => {
    const d = inviteDeps();
    d.mlsService.getGroupRosterAtGeneration = vi.fn(async () => ({
      members: [{ userId: 'u1' }],
      seatGeneration: 5,
    }));

    expect(await inviteMembersToGroup(['joe'], convo, d.deps as never, { answering })).toEqual({
      kind: 'not-added',
      reason: 'removed-meanwhile',
    });
    expect(d.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });

  it('stages nothing when the seat now awaits under ANOTHER ask', async () => {
    const d = inviteDeps();
    d.mlsService.getGroupRosterAtGeneration = vi.fn(async () => ({
      members: [{ userId: 'u1' }, { userId: 'joe', awaitingAdmission: true, askId: 'ask-2' }],
      seatGeneration: 6,
    }));

    expect(await inviteMembersToGroup(['joe'], convo, d.deps as never, { answering })).toEqual({
      kind: 'not-added',
      reason: 'removed-meanwhile',
    });
    expect(d.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });

  it('adds when the very ask it answers is still open', async () => {
    const d = inviteDeps();
    d.mlsService.getGroupRosterAtGeneration = vi.fn(async () => ({
      members: [{ userId: 'u1' }, { userId: 'joe', awaitingAdmission: true, askId: 'ask-1' }],
      seatGeneration: 6,
    }));
    d.mlsService.addMembersBulk = vi.fn(async () => ({
      addedDeviceIds: ['joe-dev'],
      skipped: [],
      welcome: new Uint8Array([1]),
    }));

    expect(await inviteMembersToGroup(['joe'], convo, d.deps as never, { answering })).toEqual({
      kind: 'added',
      addedUsers: ['joe'],
    });
  });

  it('stages nothing when the ask cannot be read', async () => {
    const d = inviteDeps();
    d.mlsService.getGroupRosterAtGeneration = vi.fn(async () => {
      throw new Error('502');
    });

    const outcome = await inviteMembersToGroup(['joe'], convo, d.deps as never, { answering });

    expect(outcome.kind).toBe('not-added');
    expect(d.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });
});
