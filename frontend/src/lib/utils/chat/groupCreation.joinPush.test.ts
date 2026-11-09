// @vitest-environment happy-dom
import { SvelteMap } from 'svelte/reactivity';

/** Who is signed in on this install: the inviter, then the newcomer reading what reached them. */
const me = vi.hoisted(() => ({ id: 'alice' }));

vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => me.id }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: { isMessageCatchupActive: false, resetMessageCatchupState: vi.fn() },
}));
vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));
// The acting device's own notice resolves names: a profile read nothing here is about.
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  resolveDisplayNames: async () => (id: string) => id,
}));

import type { IStorage, StoredMessage } from '$lib/db';
import { addressedHistoryAnswer } from '$lib/mls-client/frameDelivery';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { decodeAppMessage } from '$lib/proto/codec';
import {
  applyNickname,
  forgetConversationNicknames,
  mergeBundleNicknames,
  nicknameEntry,
} from '$lib/utils/users/conversationNicknames.svelte';
import { inviteMembersToGroup } from './groupCreation';
import { digestIdentity } from './historyDigestRendezvous';

const GROUP = 'g1';
/** Server time the newcomer was admitted at: everything before it is withheld from them (step A). */
const ARRIVAL = 1_700_000_100_000;
const PAST: StoredMessage = {
  id: 'before-beta',
  senderId: 'gamma',
  content: 'sent before beta was added',
  timestamp: ARRIVAL - 60_000,
  serverTimestamp: ARRIVAL - 60_000,
} as StoredMessage;

function inviter() {
  const mlsService = createMlsServiceStub({
    fetchUserDevices: vi.fn(async (u: string) => [{ deviceId: `${u}-dev` }]),
    getGroupRosterAtGeneration: vi.fn(async () => ({
      members: [{ userId: 'alice' }, { userId: 'gamma' }],
      seatGeneration: 3,
    })),
    getGroupUserMembers: vi.fn(async () => [{ userId: 'alice' }, { userId: 'gamma' }]),
    addMembersBulk: vi.fn(async () => ({
      addedDeviceIds: ['beta-dev'],
      skipped: [],
      welcome: new Uint8Array([1]),
    })),
    getDeviceId: vi.fn(() => 'alice-dev'),
    // The newcomer's own window as the server states it: out of the group until their arrival.
    getGroupWithheld: vi.fn(
      async (_g: string, forUserId?: string) =>
        new Map(forUserId ? [[forUserId.toLowerCase(), [{ from: 0, until: ARRIVAL }]]] : [])
    ),
  });
  const storage = {
    getMessages: vi.fn(async () => [PAST]),
    getConversation: vi.fn(async () => null),
  } as unknown as IStorage;
  return {
    mlsService,
    deps: {
      mlsService,
      storage,
      userId: 'alice',
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

/** Every `history_bundle` the inviter sent, with how it was routed. */
function bundlesSent(mlsService: ReturnType<typeof createMlsServiceStub>) {
  return vi
    .mocked(mlsService.sendMessage)
    .mock.calls.map(([, bytes, , delivery]) => {
      const system = decodeAppMessage(bytes as Uint8Array)?.system;
      return { event: system?.event, data: JSON.parse(system?.data || '{}'), delivery };
    })
    .filter((f) => f.event === 'history_bundle');
}

/**
 * THE MEMBER'S "AJOUTER" OWES THE JOIN PUSH (reading 2 of "Modifier les pseudos", FAILED on
 * `1.6.9-alpha.1`): `inviteMembersToGroup` delivered its Welcomes and pushed nothing, so a person
 * added there never learned a nickname set before them - the push is the one bundle a register is
 * taken from. Driven through the real Add path, never through the bundle builder alone.
 */
describe('inviteMembersToGroup - the join push hands a newcomer the nickname register', () => {
  beforeEach(() => {
    localStorage.clear();
    me.id = 'alice';
  });
  afterEach(() => {
    forgetConversationNicknames('alice');
    forgetConversationNicknames('beta');
    localStorage.clear();
  });

  it('pushes the register to the added device, addressed to it, with none of the past', async () => {
    applyNickname(GROUP, 'gamma', { nickname: 'Gam', setBy: 'alice', at: ARRIVAL - 30_000 });
    const { mlsService, deps } = inviter();

    const outcome = await inviteMembersToGroup(['beta'], { id: GROUP } as never, deps as never);

    expect(outcome.kind).toBe('added');
    const to = digestIdentity('beta', 'beta-dev');
    const bundles = bundlesSent(mlsService);
    expect(bundles).toHaveLength(1);
    const [push] = bundles;
    expect(push.data).toMatchObject({ to, join: true, last: true, messages: [] });
    expect(push.delivery).toEqual(addressedHistoryAnswer(to));
    expect(push.data.nicknames).toEqual([
      expect.objectContaining({ userId: 'gamma', nickname: 'Gam', setBy: 'alice' }),
    ]);

    // And the newcomer takes it, as `mergeBundleNicknames` does for an accepted join push.
    me.id = 'beta';
    const taken = mergeBundleNicknames(GROUP, push.data.nicknames, {
      members: new Set(['alice', 'gamma', 'beta']),
      serverAt: ARRIVAL + 1_000,
    });
    expect(taken).toBe(1);
    expect(nicknameEntry(GROUP, 'gamma')).toMatchObject({ nickname: 'Gam', verified: false });
  });

  it('pushes nothing to a device whose Welcome was not delivered', async () => {
    applyNickname(GROUP, 'gamma', { nickname: 'Gam', setBy: 'alice', at: ARRIVAL - 30_000 });
    const { mlsService, deps } = inviter();
    vi.mocked(mlsService.sendWelcome).mockRejectedValue(new Error('delivery down'));

    await inviteMembersToGroup(['beta'], { id: GROUP } as never, deps as never);

    expect(bundlesSent(mlsService)).toEqual([]);
  });
});
