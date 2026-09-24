/**
 * A CREATION THAT FAILS MUST SAY WHICH FAILURE IT WAS, AND THE ANSWER IS A TYPE.
 *
 * `createNewGroup` and `startNewConversation` used to return `void`. Every way they can decline -
 * a duplicate name, a block, an unreachable block check, a peer who has never signed in, and
 * anything thrown - ended in a `log()` line and nothing else, so the creation modal closed on every
 * call. The member was shown an unchanged sidebar and left to work out why, and nothing on screen
 * ever said.
 *
 * This suite pins the discriminators rather than the sentences: the screen maps them in exactly one
 * place (`conversationRefusalMessage`), and a test that asserted prose would be the second reader
 * of that prose - the thing the repo's "never branch on an error MESSAGE" rule exists to prevent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: {
    isMessageCatchupActive: false,
    resetMessageCatchupState: vi.fn(),
  },
}));

vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));

import { isBlockedWith } from '$lib/users/blocks';
import { createNewGroup, startNewConversation, type ConversationRefusal } from './groupCreation';
import { conversationRefusalMessage } from './conversationRefusalMessage';

/** Deps for the named-group path. Everything succeeds unless a case replaces one mock. */
function groupDeps(conversations = new SvelteMap<string, { name?: string }>()) {
  const local = new Set<string>();
  const mlsService = {
    createRemoteGroup: vi.fn(async () => 'g-new'),
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

/** Deps for the direct-conversation path, with a peer that has one device. */
function dmDeps() {
  const local = new Set<string>();
  const mlsService = {
    getUserGroups: vi.fn(async () => []),
    fetchUserDevices: vi.fn(async (uid: string) =>
      uid === 'peer' ? [{ deviceId: 'peer-dev' }] : []
    ),
    getDeviceId: vi.fn(() => 'dev-1'),
    createRemoteGroup: vi.fn(async () => 'g-dm'),
    registerMember: vi.fn(async () => {}),
    createGroup: vi.fn(async (id: string) => {
      local.add(id);
    }),
    getLocalGroups: vi.fn(() => Array.from(local)),
    acquireAddLock: vi.fn(async () => true),
    releaseAddLock: vi.fn(async () => {}),
    addMembersBulk: vi.fn(async () => ({
      addedDeviceIds: ['peer-dev'],
      skippedDeviceIds: [],
      welcome: new Uint8Array([1]),
    })),
    sendWelcome: vi.fn(async () => {}),
    deleteGroupOnServer: vi.fn(async () => {}),
  };
  return {
    local,
    mlsService,
    args: {
      mlsService: mlsService as never,
      storage: null,
      userId: 'me',
      deviceKeyB64: 'k',
      historyBaseUrl: 'https://example.invalid',
      conversations: new SvelteMap<string, { lifecycle?: string }>(),
      selectConversation: vi.fn(),
      saveConversation: vi.fn(async () => {}),
      log: vi.fn(),
    },
  };
}

beforeEach(() => {
  vi.mocked(isBlockedWith).mockResolvedValue(false);
});

describe('createNewGroup names its refusal', () => {
  it('answers `duplicate-group-name` rather than silently doing nothing', async () => {
    const conversations = new SvelteMap<string, { name?: string }>([
      ['g-old', { name: 'Equipe', conversationType: 'group' } as never],
    ]);
    const d = groupDeps(conversations);

    const outcome = await createNewGroup('equipe', d.args as never);

    expect(outcome).toEqual({ ok: false, reason: 'duplicate-group-name' });
    // Nothing was created: the refusal is the whole of what happened.
    expect(d.mlsService.createRemoteGroup).not.toHaveBeenCalled();
  });

  it('answers `creation-failed` when the group could not be built', async () => {
    const d = groupDeps();
    d.mlsService.registerMember = vi.fn(async () => {
      throw new Error('server said no');
    });

    const outcome = await createNewGroup('Equipe', d.args as never);

    expect(outcome).toEqual({ ok: false, reason: 'creation-failed' });
    // And the orphan is still cleaned up - answering does not replace the repair.
    expect(d.mlsService.deleteGroupOnServer).toHaveBeenCalledWith('g-new');
  });

  it('answers with the key of the group it created', async () => {
    const d = groupDeps();

    const outcome = await createNewGroup('Equipe', d.args as never);

    expect(outcome).toEqual({ ok: true, key: 'g-new' });
  });
});

describe('startNewConversation names its refusal', () => {
  it('answers `blocked` when a block stands between the two accounts', async () => {
    vi.mocked(isBlockedWith).mockResolvedValue(true);
    const d = dmDeps();

    const outcome = await startNewConversation('peer', d.args as never);

    expect(outcome).toEqual({ ok: false, reason: 'blocked' });
    expect(d.mlsService.createRemoteGroup).not.toHaveBeenCalled();
  });

  it('separates "could not ask about blocks" from "blocked"', async () => {
    // A failure to ask is not an answer, and the two must not collapse: one is the member's peer
    // refusing contact, the other is core-service being unreachable for a moment.
    vi.mocked(isBlockedWith).mockRejectedValue(new Error('core-service unreachable'));
    const d = dmDeps();

    const outcome = await startNewConversation('peer', d.args as never);

    expect(outcome).toEqual({ ok: false, reason: 'block-check-unavailable' });
    expect(d.mlsService.createRemoteGroup).not.toHaveBeenCalled();
  });

  it('answers `peer-has-no-device` when the peer has never signed in', async () => {
    const d = dmDeps();
    d.mlsService.fetchUserDevices = vi.fn(async () => []);

    const outcome = await startNewConversation('peer', d.args as never);

    expect(outcome).toEqual({ ok: false, reason: 'peer-has-no-device' });
    expect(d.mlsService.createRemoteGroup).not.toHaveBeenCalled();
  });

  it('answers `creation-failed` when the local state vanished mid-creation', async () => {
    const d = dmDeps();
    d.mlsService.addMembersBulk = vi.fn(async () => {
      d.local.delete('g-dm');
      return { addedDeviceIds: [], skippedDeviceIds: [], welcome: undefined as never };
    });

    const outcome = await startNewConversation('peer', d.args as never);

    expect(outcome).toEqual({ ok: false, reason: 'creation-failed' });
    expect(d.mlsService.deleteGroupOnServer).toHaveBeenCalledWith('g-dm');
  });

  it('answers with the key of the conversation it opened', async () => {
    const d = dmDeps();

    const outcome = await startNewConversation('peer', d.args as never);

    expect(outcome).toEqual({ ok: true, key: 'g-dm' });
  });
});

describe('every refusal has a sentence', () => {
  /**
   * Listed by hand rather than derived: TypeScript already makes the MAPPING total, and this array
   * is the other half - a member added to the type and to the map but left out here fails the
   * length assertion, which is what catches a reason nobody wrote a message for.
   */
  const ALL: ConversationRefusal[] = [
    'duplicate-group-name',
    'blocked',
    'block-check-unavailable',
    'peer-has-no-device',
    'creation-failed',
  ];

  it('renders a distinct, non-empty line for each', () => {
    const lines = ALL.map(conversationRefusalMessage);

    expect(lines).toHaveLength(5);
    for (const line of lines) expect(line.trim().length).toBeGreaterThan(0);
    // Two refusals sharing a sentence would tell the member the same thing about different causes.
    expect(new Set(lines).size).toBe(ALL.length);
  });
});
