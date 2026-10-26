import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { isBlockedWith } from '$lib/users/blocks';
import { DeliveryRenewalFailedError } from '$lib/mls-client/mlsDeliveryApi';
import { TransportFailureError } from '$lib/utils/transportFailure';
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

  /**
   * NET-3 (1.4.1 campaign): a request with NO ANSWER before the commit left - typed at the throw, a
   * `TransportFailureError` that is not a `CommitOutcomeUnknownError` - staged nothing and kept
   * nothing. It is not a failure of the invitation, and is not said as one.
   */
  it('answers `unreachable` when a request before the commit got no answer', async () => {
    const d = inviteDeps();
    d.mlsService.registerMember = vi.fn(async () => {
      throw new TransportFailureError(new TypeError('Failed to fetch'));
    });

    expect(await inviteMembersToGroup(['bob'], convo, d.deps as never)).toEqual({
      kind: 'not-added',
      reason: 'unreachable',
    });
    expect(d.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });

  it('answers `unreachable` when no device read of anybody was answered', async () => {
    const d = inviteDeps();
    d.mlsService.fetchUserDevices = vi.fn(async () => {
      throw new TransportFailureError(new TypeError('Failed to fetch'));
    });

    const outcome = await inviteMembersToGroup(['bob'], convo, d.deps as never);

    expect(outcome).toEqual({ kind: 'not-added', reason: 'unreachable' });
  });

  it('answers `no-devices` only when the server SAID nobody has a device', async () => {
    const d = inviteDeps();
    d.mlsService.fetchUserDevices = vi.fn(async () => []);

    const outcome = await inviteMembersToGroup(['bob'], convo, d.deps as never);

    expect(outcome).toEqual({ kind: 'not-added', reason: 'no-devices' });
  });
});

/**
 * AN INVITEE THE ADD COULD NOT REACH IS NAMED, NEVER DROPPED SILENTLY (1.4.1 dev campaign): with
 * several invitees, the others are added and the gesture reads as a success - so the outcome carries
 * whoever was left out, and why. A blocked invitee is skipped deliberately and is not one of them.
 */
describe('inviteMembersToGroup - names whoever it left out', () => {
  it('a block check that threw leaves that person out, named `unchecked`; the others are added', async () => {
    const d = inviteDeps();
    vi.mocked(isBlockedWith).mockImplementation(async (u: string) => {
      if (u === 'carol') throw new TransportFailureError(new TypeError('Failed to fetch'));
      return false;
    });
    d.mlsService.addMembersBulk = vi.fn(async () => ({
      addedDeviceIds: ['bob-dev'],
      skipped: [],
      welcome: new Uint8Array([1]),
    }));

    const outcome = await inviteMembersToGroup(['bob', 'carol'], convo, d.deps as never);

    expect(outcome).toEqual({
      kind: 'added',
      addedUsers: ['bob'],
      leftOut: [{ userId: 'carol', why: 'unchecked' }],
    });
    vi.mocked(isBlockedWith).mockResolvedValue(false);
  });

  it('an empty device answer is `no-device`, an unanswered read is `unchecked`', async () => {
    const d = inviteDeps();
    d.mlsService.fetchUserDevices = vi.fn(async (u: string) => {
      if (u === 'carol') return [];
      if (u === 'dave') throw new TransportFailureError(new TypeError('Failed to fetch'));
      return [{ deviceId: `${u}-dev` }];
    });
    d.mlsService.addMembersBulk = vi.fn(async () => ({
      addedDeviceIds: ['bob-dev'],
      skipped: [],
      welcome: new Uint8Array([1]),
    }));

    const outcome = await inviteMembersToGroup(['bob', 'carol', 'dave'], convo, d.deps as never);

    expect(outcome).toEqual({
      kind: 'added',
      addedUsers: ['bob'],
      leftOut: [
        { userId: 'carol', why: 'no-device' },
        { userId: 'dave', why: 'unchecked' },
      ],
    });
  });

  it('a blocked invitee is NOT named: that skip is deliberate', async () => {
    const d = inviteDeps();
    vi.mocked(isBlockedWith).mockImplementation(async (u: string) => u === 'carol');
    d.mlsService.addMembersBulk = vi.fn(async () => ({
      addedDeviceIds: ['bob-dev'],
      skipped: [],
      welcome: new Uint8Array([1]),
    }));

    const outcome = await inviteMembersToGroup(['bob', 'carol'], convo, d.deps as never);

    expect(outcome).toEqual({ kind: 'added', addedUsers: ['bob'] });
    vi.mocked(isBlockedWith).mockResolvedValue(false);
  });
});

/**
 * ONE OUTCOME, ONE LINE (TOK-2, 1.4.1 campaign: a failed Add was said three times in 3 ms - an
 * untagged log line, an error with a stack, and the reporter's echo). The line is the outcome's,
 * tagged, at `warn` for a typed failure; `error` with its stack only for an untyped cause.
 */
describe('inviteMembersToGroup - says its outcome once', () => {
  let lines: { level: string; text: string }[];
  beforeEach(() => {
    lines = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push({ level, text: String(args[0]) });
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  const outcomeLines = () => lines.filter((l) => !l.text.startsWith('Inviting '));

  it('a typed failure (a renewal that failed behind the commit) is ONE warn, no stack', async () => {
    const d = inviteDeps();
    d.mlsService.addMembersBulk = vi.fn(async () => {
      throw new DeliveryRenewalFailedError(
        'POST /api/mls/commit',
        new TransportFailureError(new TypeError('Failed to fetch'))
      );
    });

    await inviteMembersToGroup(['bob'], convo, d.deps as never);

    expect(outcomeLines()).toEqual([
      {
        level: 'warn',
        text: expect.stringMatching(
          /^\[GROUP\] an invitation added nobody \(failed\) in g1\.\.\.: DeliveryRenewalFailedError: /
        ),
      },
    ]);
  });

  it('an untyped cause is ONE error, carrying the error itself', async () => {
    const d = inviteDeps();
    const boom = new Error('boom');
    d.mlsService.addMembersBulk = vi.fn(async () => {
      throw boom;
    });
    const errors = vi.mocked(console.error);

    await inviteMembersToGroup(['bob'], convo, d.deps as never);

    expect(outcomeLines().map((l) => l.level)).toEqual(['error']);
    expect(errors).toHaveBeenCalledExactlyOnceWith(
      '[GROUP] an invitation added nobody (failed) in g1...: Error: boom',
      boom
    );
  });

  it('a refusal is ONE warn naming its reason', async () => {
    const d = inviteDeps();
    d.mlsService.acquireAddLock = vi.fn(async () => false);

    await inviteMembersToGroup(['bob'], convo, d.deps as never);

    expect(outcomeLines()).toEqual([
      { level: 'warn', text: '[GROUP] an invitation added nobody (add-lock-busy) in g1...' },
    ]);
  });
});
