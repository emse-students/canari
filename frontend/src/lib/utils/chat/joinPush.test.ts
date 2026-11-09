// @vitest-environment happy-dom

/** Who is signed in on this install: the inviter, then the newcomer reading what reached them. */
const me = vi.hoisted(() => ({ id: 'alice' }));

vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => me.id }));
vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));

import type { IStorage, StoredMessage } from '$lib/db';
import type { DeliveredWelcome } from '$lib/mls-client/IMlsService';
import { addressedHistoryAnswer } from '$lib/mls-client/frameDelivery';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { decodeAppMessage } from '$lib/proto/codec';
import {
  applyNickname,
  forgetConversationNicknames,
  mergeBundleNicknames,
  nicknameEntry,
} from '$lib/utils/users/conversationNicknames.svelte';
import { digestIdentity } from './historyDigestRendezvous';
import { AddressedUnsupportedError, type SentFrame } from '$lib/mls-client/mlsDeliveryApi';
import { installJoinPush, queueJoinPush, type JoinPushDeps } from './joinPush';

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
const DELIVERED: DeliveredWelcome = {
  groupId: GROUP,
  userId: 'beta',
  deviceId: 'beta-dev',
  welcome: new Uint8Array([1, 2, 3]),
};

function inviter() {
  const mlsService = createMlsServiceStub({
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
  const deps: JoinPushDeps = {
    session: () => ({ account: 'alice', storage, deviceKeyB64: 'k' }),
    isCurrent: () => true,
    log: vi.fn(),
  };
  return { mlsService, storage, deps };
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
 * THE JOIN PUSH FOLLOWS EVERY DELIVERED WELCOME (reading 2 of "Modifier les pseudos", FAILED on
 * `1.6.9-alpha.1`): the member's "Ajouter" and the owed-Welcome drain delivered Welcomes and pushed
 * nothing, so a newcomer never learned a nickname set before them. `BaseMlsService` announces each
 * delivery (its own tests); this is what the announcement starts.
 */
describe('the join push of a delivered Welcome', () => {
  beforeEach(() => {
    localStorage.clear();
    me.id = 'alice';
    applyNickname(GROUP, 'gamma', { nickname: 'Gam', setBy: 'alice', at: ARRIVAL - 30_000 });
  });
  afterEach(() => {
    forgetConversationNicknames('alice');
    forgetConversationNicknames('beta');
    localStorage.clear();
  });

  it('pushes the register to the delivered device, addressed to it, with none of the past', async () => {
    const { mlsService, deps } = inviter();

    await queueJoinPush(mlsService, DELIVERED, deps);

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

  it('pushes once per Welcome: the same bytes delivered again (a reload that lost the clear) push nothing', async () => {
    const { mlsService, deps } = inviter();

    await queueJoinPush(mlsService, DELIVERED, deps);
    await queueJoinPush(mlsService, { ...DELIVERED, welcome: new Uint8Array([1, 2, 3]) }, deps);

    expect(bundlesSent(mlsService)).toHaveLength(1);
  });

  it('pushes again for a LATER Welcome to the same device - a re-add is a new admission', async () => {
    const { mlsService, deps } = inviter();

    await queueJoinPush(mlsService, DELIVERED, deps);
    await queueJoinPush(mlsService, { ...DELIVERED, welcome: new Uint8Array([9]) }, deps);

    expect(bundlesSent(mlsService)).toHaveLength(2);
  });

  it('pushes nothing into a key group', async () => {
    const { mlsService, deps } = inviter();
    vi.mocked(mlsService.isDistributionGroup).mockReturnValue(true);

    await queueJoinPush(mlsService, DELIVERED, deps);

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
  });

  it('is started by the delivery itself, never awaited by it, and one failing push does not stop the next', async () => {
    const { mlsService, deps } = inviter();
    let listener: ((d: DeliveredWelcome) => void) | undefined;
    vi.mocked(mlsService.onWelcomeDelivered).mockImplementation((l) => {
      listener = l;
    });
    installJoinPush(mlsService, deps);
    vi.mocked(mlsService.sendMessage).mockRejectedValueOnce(new Error('send down'));

    // Synchronous, returns nothing to await: the delivery goes on whatever the push does.
    expect(listener?.(DELIVERED)).toBeUndefined();
    await queueJoinPush(mlsService, { ...DELIVERED, deviceId: 'beta-dev-2' }, deps);

    const to = bundlesSent(mlsService).map((b) => b.data.to);
    expect(to).toEqual([digestIdentity('beta', 'beta-dev'), digestIdentity('beta', 'beta-dev-2')]);
    expect(vi.mocked(deps.log).mock.calls.some(([l]) => String(l).includes('send error'))).toBe(
      true
    );
  });

  it('runs a push queued before an account switch with the account that delivered it, or not at all', async () => {
    const { mlsService, deps } = inviter();
    // Account A's client delivers two Welcomes; the first push is still running when the switch lands.
    let release: () => void = () => {};
    vi.mocked(mlsService.sendMessage).mockImplementationOnce(
      () =>
        new Promise(
          (resolve) =>
            (release = () =>
              resolve({ sealed: new Uint8Array(), receivedAt: ARRIVAL } as SentFrame))
        )
    );
    let current = true;
    let session = deps.session();
    const switching: JoinPushDeps = {
      session: () => session,
      isCurrent: () => current,
      log: deps.log,
    };
    const first = queueJoinPush(mlsService, DELIVERED, switching);
    const second = queueJoinPush(
      mlsService,
      { ...DELIVERED, deviceId: 'beta-dev-2', welcome: new Uint8Array([7]) },
      switching
    );
    await vi.waitFor(() => expect(mlsService.sendMessage).toHaveBeenCalledTimes(1));

    // The switch: A's client is retired, and the session now names account B's store and key.
    current = false;
    const storageOfB = { getMessages: vi.fn(), getConversation: vi.fn() } as unknown as IStorage;
    session = { account: 'bob', storage: storageOfB, deviceKeyB64: 'kb' };
    release();
    await Promise.all([first, second]);

    // The queued second push never ran: nothing more sent, B's store never read, B's ledger untouched.
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(storageOfB.getMessages).not.toHaveBeenCalled();
    expect(localStorage.getItem('mls_join_pushes_sent:v1:bob')).toBeNull();
    expect(
      vi
        .mocked(deps.log)
        .mock.calls.some(([l]) => String(l).includes('was retired before its turn'))
    ).toBe(true);

    // And a delivery announced by the retired client pushes nothing either.
    await queueJoinPush(mlsService, { ...DELIVERED, welcome: new Uint8Array([8]) }, switching);
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('reads the session at the announcement, not at the turn: a push queued behind a slow one keeps its account', async () => {
    const { mlsService, storage, deps } = inviter();
    let release: () => void = () => {};
    vi.mocked(mlsService.sendMessage).mockImplementationOnce(
      () =>
        new Promise(
          (resolve) =>
            (release = () =>
              resolve({ sealed: new Uint8Array(), receivedAt: ARRIVAL } as SentFrame))
        )
    );
    let account = 'alice';
    const reading: JoinPushDeps = {
      session: () => ({ account, storage, deviceKeyB64: 'k' }),
      isCurrent: () => true,
      log: deps.log,
    };
    const first = queueJoinPush(mlsService, DELIVERED, reading);
    const second = queueJoinPush(mlsService, { ...DELIVERED, deviceId: 'beta-dev-2' }, reading);
    account = 'someone-else';
    await vi.waitFor(() => expect(mlsService.sendMessage).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);

    const ledger = JSON.parse(localStorage.getItem('mls_join_pushes_sent:v1:alice') ?? '[]');
    expect(ledger).toHaveLength(2);
    expect(localStorage.getItem('mls_join_pushes_sent:v1:someone-else')).toBeNull();
  });

  it('says at warn when the newcomer could not be addressed - offline at the push, the known limit', async () => {
    const { mlsService, deps } = inviter();
    vi.mocked(mlsService.sendMessage).mockRejectedValueOnce(
      new AddressedUnsupportedError(GROUP, ['beta:beta-dev'])
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await queueJoinPush(mlsService, DELIVERED, deps);

    expect(
      warn.mock.calls.some(([l]) => String(l).includes('[JOIN_PUSH] g1... NOT DELIVERED'))
    ).toBe(true);
    warn.mockRestore();
  });
});
