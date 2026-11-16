// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: {
    isMessageCatchupActive: false,
    resetMessageCatchupState: vi.fn(),
  },
}));

vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));

import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import { createNewGroup, startNewConversation } from './groupCreation';
import { isGroupInCreation } from './groupsInCreation';
import { ensureConversationForServerGroup } from './serverGroupConversation';
import { processPendingInvitations } from './actions';
import { groupsOwingAudit, resetAuditRecord } from './historyReconcile';

/**
 * THE CONNECTION SWEEPS RUN INSIDE A CREATION'S WINDOW, AND FIND NOTHING TO DO THERE.
 *
 * LEAF-REFRESH-1 (web rig, 2026-11-16) creates a group a second after a reload, inside the
 * connection pass. The creation registers the membership first - so the server lists the group and
 * holds a `pending` row for each of the user's other devices - and writes the conversation row only
 * at the end. The two sweeps read that interval as a group this device lost: discovery wrote
 * `[DISCOVERY] Placeholder`, the pending sweep requested a re-add recovery (`absent locally ->
 * recovery requested`), and the recovery refused with `already in WASM`.
 *
 * No timer here: each sweep is run AT the exact step of the creation where it overlapped on the rig
 * - after `registerMember` has been answered, which is the earliest a server answer can name the
 * group, and while the bulk Add is staged.
 */

/** The sweeps, run against the state the creation has at the moment they are called. */
async function runBothSweeps(
  groupId: string,
  isGroup: boolean,
  conversations: Map<string, Conversation>
) {
  const sweepMls = {
    getDeviceId: vi.fn(() => 'dev-1'),
    getLocalGroups: vi.fn(() => [groupId]),
    // What the server answers right after `registerMember`: the user's other device is pending.
    getPendingInvitations: vi.fn(async () => [
      { id: 'i1', userId: 'me', deviceId: 'dev-2', groupId, status: 'pending' },
    ]),
    getUserGroupMembers: vi.fn(async () => ['me', 'peer']),
    getUserGroups: vi.fn(async () => [{ groupId, name: 'Equipe', isGroup, deletedAt: null }]),
    // The creation holds the group's add lock while it stages its Add.
    acquireAddLock: vi.fn(async () => false),
    notifyConversationAvailable: vi.fn(),
  } as unknown as IMlsService;
  const requestReAdd = vi.fn(async () => {});
  const onGroupNotSwept = vi.fn();
  const log = vi.fn();

  // In the rig's order: the pending sweep's line came 6 ms before the placeholder.
  await processPendingInvitations({
    mlsService: sweepMls,
    userId: 'me',
    deviceKeyB64: 'k',
    conversations,
    requestReAdd,
    log,
    onGroupNotSwept,
  });
  const discovered = await ensureConversationForServerGroup(
    { groupId, name: isGroup ? 'Equipe' : 'me::peer', isGroup },
    {
      mlsService: sweepMls,
      userId: 'me',
      conversations,
      owedExits: new Set(),
      log,
    }
  );
  return { discovered, requestReAdd, onGroupNotSwept, log, rowsAtSweep: conversations.size };
}

type Sweep = Awaited<ReturnType<typeof runBothSweeps>>;

function expectNothingTaken(sweep: Sweep | undefined, groupId: string) {
  expect(sweep).toBeDefined();
  expect(sweep!.discovered).toBe('in-creation');
  expect(sweep!.rowsAtSweep).toBe(0);
  expect(sweep!.requestReAdd).not.toHaveBeenCalled();
  // Its rows were not read through, so the asks shown for it stay as they are.
  expect(sweep!.onGroupNotSwept).toHaveBeenCalledWith(groupId);
  const lines = sweep!.log.mock.calls.map((c) => String(c[0]));
  expect(
    lines.filter((l) =>
      /Placeholder|absent locally|recovery requested|pending invitation(s) to process/.test(l)
    )
  ).toEqual([]);
}

function groupMls(onRegistered: () => Promise<void>, onStaged: () => Promise<void>) {
  const local = new Set<string>();
  return {
    local,
    mls: {
      createRemoteGroup: vi.fn(async () => 'g-new'),
      registerMember: vi.fn(async () => {
        await onRegistered();
      }),
      createGroup: vi.fn(async (id: string) => {
        local.add(id);
      }),
      fetchUserDevices: vi.fn(async () => [{ deviceId: 'dev-2' }]),
      getDeviceId: vi.fn(() => 'dev-1'),
      getLocalGroups: vi.fn(() => Array.from(local)),
      acquireAddLock: vi.fn(async () => true),
      releaseAddLock: vi.fn(async () => {}),
      getGroupMemberIdentities: vi.fn(async () => [] as string[]),
      runUnderMlsLock: vi.fn((fn: () => Promise<unknown>) => fn()),
      addMembersBulk: vi.fn(async () => {
        await onStaged();
        return { addedDeviceIds: ['dev-2'], skipped: [], notAdmitted: [], welcome: undefined };
      }),
      sendWelcome: vi.fn(async () => {}),
      deleteGroupOnServer: vi.fn(async () => {}),
    },
  };
}

function args(mls: unknown, conversations: SvelteMap<string, Conversation>) {
  return {
    mlsService: mls as never,
    storage: null,
    userId: 'me',
    deviceKeyB64: 'k',
    historyBaseUrl: 'https://example.invalid',
    conversations,
    selectConversation: vi.fn(),
    saveConversation: vi.fn(async () => {}),
    log: vi.fn(),
  };
}

describe('createNewGroup - the connection sweeps never take a group this device is creating', () => {
  it('discovery writes no placeholder and the pending sweep requests no recovery, at either step', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    let afterRegister: Sweep | undefined;
    let whileStaged: Sweep | undefined;
    const { mls } = groupMls(
      async () => {
        afterRegister = await runBothSweeps('g-new', true, conversations);
      },
      async () => {
        whileStaged = await runBothSweeps('g-new', true, conversations);
      }
    );

    const outcome = await createNewGroup('Equipe', args(mls, conversations) as never);

    expect(outcome).toEqual({ ok: true, key: 'g-new' });
    expectNothingTaken(afterRegister, 'g-new');
    expectNothingTaken(whileStaged, 'g-new');
    // The one row is the creation's own, written once, `active`.
    expect(conversations.get('g-new')?.lifecycle).toBe('active');
    expect(isGroupInCreation('g-new')).toBe(false);
  });

  it('releases the mark when the creation fails, after the server group is deleted', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    const { mls } = groupMls(
      async () => {},
      async () => {}
    );
    let markedAtDelete: boolean | undefined;
    mls.createGroup = vi.fn(async () => {
      throw new Error('wasm refused');
    });
    mls.deleteGroupOnServer = vi.fn(async () => {
      markedAtDelete = isGroupInCreation('g-new');
    });

    const outcome = await createNewGroup('Equipe', args(mls, conversations) as never);

    expect(outcome.ok).toBe(false);
    // Still marked while the server group is being deleted, so no sweep takes it in between...
    expect(markedAtDelete).toBe(true);
    // ...and never outliving the creation, or the next real loss of this group would be ignored.
    expect(isGroupInCreation('g-new')).toBe(false);
  });
});

describe('startNewConversation - the same window, on the DM path', () => {
  it('discovery writes no placeholder and the pending sweep requests no recovery', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    let afterRegister: Sweep | undefined;
    const local = new Set<string>();
    const mls = {
      getUserGroups: vi.fn(async () => []),
      fetchUserDevices: vi.fn(async (uid: string) =>
        uid === 'peer' ? [{ deviceId: 'peer-dev' }] : []
      ),
      getDeviceId: vi.fn(() => 'dev-1'),
      createRemoteGroup: vi.fn(async () => 'g-dm'),
      // Called twice on this path (the creator, then every owner in `performDirectAdd`): the
      // sweep is read at the first, the earliest a server answer can name the group.
      registerMember: vi.fn(async () => {
        afterRegister ??= await runBothSweeps('g-dm', false, conversations);
      }),
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
        notAdmitted: [],
        welcome: new Uint8Array([1]),
      })),
      sendWelcome: vi.fn(async () => {}),
      deleteGroupOnServer: vi.fn(async () => {}),
    };

    const outcome = await startNewConversation('peer', args(mls, conversations) as never);

    expect(outcome).toEqual({ ok: true, key: 'g-dm' });
    expectNothingTaken(afterRegister, 'g-dm');
    expect(isGroupInCreation('g-dm')).toBe(false);
  });
});

/**
 * A GROUP THIS DEVICE CREATED OWES NO HISTORY AUDIT - BUT ONLY ONCE IT WAS CREATED.
 *
 * The record is written on SUCCESS, never earlier: a tab that died mid-creation while the server
 * group survived comes back to a group it rejoins under a discovery placeholder, a path that skips
 * the post-Welcome history ask - so a record written before success would leave the messages of
 * the user's other devices never asked for. While the creation runs, the connection pass leaves the
 * group out by its mark instead (`initializeConnection.test.ts`). Both paths (a follower's creation
 * is delegated to these same functions).
 */
describe('a created group is recorded as audited on success only', () => {
  const owing = (id: string) => groupsOwingAudit('me', 'dev-1', [id]);

  it('createNewGroup: still owed while createGroup runs, recorded once it answered ok', async () => {
    resetAuditRecord('me', 'dev-1');
    let owingAtCreate: string[] | undefined;
    const { mls } = groupMls(
      async () => {},
      async () => {}
    );
    const local = new Set<string>();
    mls.getLocalGroups = vi.fn(() => Array.from(local));
    mls.createGroup = vi.fn(async (id: string) => {
      owingAtCreate = owing(id);
      local.add(id);
    });

    const outcome = await createNewGroup(
      'Equipe',
      args(mls, new SvelteMap<string, Conversation>()) as never
    );

    expect(outcome.ok).toBe(true);
    expect(owingAtCreate).toEqual(['g-new']);
    expect(owing('g-new')).toEqual([]);
  });

  it('createNewGroup: a creation that fails leaves the group owed', async () => {
    resetAuditRecord('me', 'dev-1');
    const { mls } = groupMls(
      async () => {},
      async () => {}
    );
    mls.createGroup = vi.fn(async () => {
      throw new Error('wasm refused');
    });

    const outcome = await createNewGroup(
      'Equipe',
      args(mls, new SvelteMap<string, Conversation>()) as never
    );

    expect(outcome.ok).toBe(false);
    expect(owing('g-new')).toEqual(['g-new']);
  });

  it('startNewConversation: still owed while createGroup runs, recorded once it answered ok', async () => {
    resetAuditRecord('me', 'dev-1');
    let owingAtCreate: string[] | undefined;
    const local = new Set<string>();
    const mls = {
      fetchUserDevices: vi.fn(async (uid: string) =>
        uid === 'peer' ? [{ deviceId: 'peer-dev' }] : []
      ),
      getDeviceId: vi.fn(() => 'dev-1'),
      createRemoteGroup: vi.fn(async () => 'g-dm2'),
      registerMember: vi.fn(async () => {}),
      createGroup: vi.fn(async (id: string) => {
        owingAtCreate = owing(id);
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
        notAdmitted: [],
        welcome: new Uint8Array([1]),
      })),
      sendWelcome: vi.fn(async () => {}),
      deleteGroupOnServer: vi.fn(async () => {}),
    };

    const outcome = await startNewConversation(
      'peer',
      args(mls, new SvelteMap<string, Conversation>()) as never
    );

    expect(outcome.ok).toBe(true);
    expect(owingAtCreate).toEqual(['g-dm2']);
    expect(owing('g-dm2')).toEqual([]);
  });
});
