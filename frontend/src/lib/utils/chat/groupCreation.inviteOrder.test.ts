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

import { inviteMembersToGroup } from './groupCreation';
import { MemberNotAdmittedError } from '$lib/mls-client/mlsDeliveryApi';
import { CommitRefusedError } from '$lib/mls-client/CommitRefusedError';

/** The gate's whole-commit refusal naming `userIds`, as the commit transaction types it. */
const admitRefused = (userIds: string[]) =>
  new CommitRefusedError('admit_refused', 1, 1, null, userIds);

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
    // A rebuild re-reads the roster (`rosterPremise`): the inviter alone, as at the start.
    getGroupUserMembers: vi.fn(async () => [{ userId: 'u1' }]),
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
    // Read by the race rule on a typed refusal: the epoch never moved.
    getEpoch: vi.fn(() => 1),
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
 * A DECLINE HOLDS AGAINST AN ADD DECIDED BEFORE IT (ADM-3). The gate refuses a commit WHOLE when it
 * would give a leaf to a person it may not admit (`ADMIT_REFUSED`, naming them): the Add is rebuilt
 * without them, they get no Welcome and are not reported added. A member-add call refused after the
 * merge (`MemberNotAdmittedError`, a departure since) withholds the Welcome too.
 */
describe('inviteMembersToGroup - a person the server did not admit', () => {
  it('rebuilds the Add without the people the gate refused, and reports only the others', async () => {
    const d = inviteDeps();
    let calls = 0;
    d.mlsService.addMembersBulk = vi.fn(async (_g: string, devices: { userId: string }[]) => {
      calls++;
      if (devices.some((x) => x.userId === 'carol')) throw admitRefused(['carol']);
      return { addedDeviceIds: ['bob-dev'], skipped: [], welcome: new Uint8Array([1]) };
    }) as never;

    const outcome = await inviteMembersToGroup(['bob', 'carol'], convo, d.deps as never);

    expect(calls).toBe(2);
    const second = vi.mocked(d.mlsService.addMembersBulk).mock.calls[1] as unknown[];
    expect((second[1] as { userId: string }[]).map((x) => x.userId)).toEqual(['bob']);
    // The intent the rebuilt commit carries no longer names them either.
    expect(second[3]).toEqual(expect.objectContaining({ users: ['bob'] }));
    expect(d.order).toContain('welcome:bob');
    expect(d.order).not.toContain('register:carol');
    expect(outcome).toEqual({ kind: 'added', addedUsers: ['bob'] });
  });

  it('answers `removed-meanwhile` when the gate refused everyone it named, and never loops', async () => {
    const d = inviteDeps();
    d.mlsService.addMembersBulk = vi.fn(async (_g: string, devices: { userId: string }[]) => {
      throw admitRefused(devices.map((x) => x.userId));
    }) as never;

    expect(await inviteMembersToGroup(['bob', 'carol'], convo, d.deps as never)).toEqual({
      kind: 'not-added',
      reason: 'removed-meanwhile',
    });
    expect(d.mlsService.addMembersBulk).toHaveBeenCalledTimes(1);
    expect(d.order.some((s) => s.startsWith('welcome:'))).toBe(false);
  });

  it('narrates a Decline that won the race as an info line, never a warning', async () => {
    const d = inviteDeps();
    d.mlsService.addMembersBulk = vi.fn(async (_g: string, devices: { userId: string }[]) => {
      throw admitRefused(devices.map((x) => x.userId));
    }) as never;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await inviteMembersToGroup(['bob'], convo, d.deps as never);

    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('abandoned'))).toEqual(
      []
    );
    expect(
      info.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('abandoned before its stage (not-admitted)'))
    ).toHaveLength(1);
    warn.mockRestore();
    info.mockRestore();
  });

  it('still warns when the Add went out without a seat generation: a read failure, not a lost race', async () => {
    const d = inviteDeps();
    d.mlsService.getGroupRosterAtGeneration = vi.fn(async () => {
      throw new Error('roster unreadable');
    }) as never;
    d.mlsService.addMembersBulk = vi.fn(async (_g: string, devices: { userId: string }[]) => {
      throw admitRefused(devices.map((x) => x.userId));
    }) as never;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await inviteMembersToGroup(['bob'], convo, d.deps as never);

    expect(
      warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('abandoned before'))
    ).toHaveLength(1);
    expect(info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('abandoned'))).toEqual(
      []
    );
    warn.mockRestore();
    info.mockRestore();
  });

  it('stops on a refusal naming nobody the Add offered: no progress, no rebuild', async () => {
    const d = inviteDeps();
    d.mlsService.addMembersBulk = vi.fn(async () => {
      throw admitRefused(['dave']);
    }) as never;

    expect(await inviteMembersToGroup(['bob'], convo, d.deps as never)).toEqual({
      kind: 'not-added',
      reason: 'failed',
    });
    expect(d.mlsService.addMembersBulk).toHaveBeenCalledTimes(1);
  });

  it('withholds the Welcome of a person the member-add call refuses after the merge', async () => {
    const d = inviteDeps(async (u) => {
      if (u === 'carol') throw new MemberNotAdmittedError('g1', 'carol');
    });

    const outcome = await inviteMembersToGroup(['bob', 'carol'], convo, d.deps as never);

    expect(d.order).toContain('welcome:bob');
    expect(d.order).not.toContain('welcome:carol');
    expect(outcome).toEqual({ kind: 'added', addedUsers: ['bob'] });
  });

  it('answers `removed-meanwhile` when the member-add call admitted nobody it named', async () => {
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

  it('narrates an ask settled before the Add as an info line, never a warning', async () => {
    const d = inviteDeps();
    d.mlsService.getGroupRosterAtGeneration = vi.fn(async () => ({
      members: [{ userId: 'u1' }],
      seatGeneration: 5,
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await inviteMembersToGroup(['joe'], convo, d.deps as never, { answering });

    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('abandoned'))).toEqual(
      []
    );
    expect(
      info.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('(removed-meanwhile): the ask of joe was settled'))
    ).toHaveLength(1);
    warn.mockRestore();
    info.mockRestore();
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
