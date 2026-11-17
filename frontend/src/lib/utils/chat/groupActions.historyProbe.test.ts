// @vitest-environment happy-dom
import { sendHistoryProbe } from './groupActions';
import {
  REGISTER_ASKS_MAX,
  clearRegisterOwed,
  isRegisterOwed,
  noteRegisterOwed,
} from './registerOwed';
import { forgetHistoryAsks, takeAddressedAsk } from './historyAddressing';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { decodeAppMessage } from '$lib/proto/codec';
import type { IStorage, StoredMessage } from '$lib/db';

/**
 * The first leg of a reconciliation, and the one leg it chooses: a state key when this device holds
 * something, the digest straight away when it holds nothing - which is how every group looks right
 * after a sign-in, and where the state key only ever earned a "describe yourself" round trip.
 */

const GROUP = 'g1';
const SELF = 'user-a:device-a';

function storageHolding(count: number | Error, messages: StoredMessage[] = []): IStorage {
  return {
    countMessages: vi
      .fn()
      .mockImplementation(() =>
        count instanceof Error ? Promise.reject(count) : Promise.resolve(count)
      ),
    getMessages: vi.fn().mockResolvedValue(messages),
    // The window read: these fixtures hold nothing below any window they are asked for.
    getMessagesSince: vi.fn().mockResolvedValue(messages),
    getConversation: vi.fn().mockResolvedValue(undefined),
  } as unknown as IStorage;
}

/** The JSON body of every system frame sent, in order. */
function sentBodies(
  mlsService: ReturnType<typeof createMlsServiceStub>
): Record<string, unknown>[] {
  return vi
    .mocked(mlsService.sendMessage)
    .mock.calls.map((call) =>
      JSON.parse(decodeAppMessage(call[1] as Uint8Array)?.system?.data ?? '{}')
    );
}

function sentEvents(mlsService: ReturnType<typeof createMlsServiceStub>): string[] {
  return vi
    .mocked(mlsService.sendMessage)
    .mock.calls.map((call) => decodeAppMessage(call[1] as Uint8Array)?.system?.event ?? '?');
}

describe('sendHistoryProbe', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('sends the DIGEST at once when the store holds nothing - one round trip, not two', async () => {
    const mlsService = createMlsServiceStub();
    const sent = await sendHistoryProbe(GROUP, SELF, {
      storage: storageHolding(0),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
    });

    expect(sent).toBe(true);
    expect(sentEvents(mlsService)).toEqual(['history_digest']);
  });

  it('keeps the STATE KEY when the store holds anything - agreement is likely and costs one frame', async () => {
    const mlsService = createMlsServiceStub();
    const held = [
      { id: 'm1', senderId: 'u', content: 'x', timestamp: Date.now() } as StoredMessage,
    ];
    await sendHistoryProbe(GROUP, SELF, {
      storage: storageHolding(1, held),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
    });

    expect(sentEvents(mlsService)).toEqual(['history_state']);
  });

  it('reads a count it could not take as "unknown", never as "empty", and says so', async () => {
    const mlsService = createMlsServiceStub();
    const log = vi.fn();
    await sendHistoryProbe(GROUP, SELF, {
      storage: storageHolding(new Error('disk gone')),
      deviceKeyB64: 'k',
      mlsService,
      log,
    });

    expect(sentEvents(mlsService)).toEqual(['history_state']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Could not count'));
  });

  // HEAL-repair: a device holding frames it cannot read says so on the probe, so a member holding
  // nothing it lacks answers instead of staying silent. Only then - the ordinary probe keeps its
  // exact shape on the wire.
  it.each([
    ['state key', 1],
    ['digest', 0],
  ])(
    'carries the proof of incompleteness on the %s only when there is one',
    async (_leg, count) => {
      const held =
        count > 0
          ? [{ id: 'm1', senderId: 'u', content: 'x', timestamp: Date.now() } as StoredMessage]
          : [];
      const deps = (mlsService: ReturnType<typeof createMlsServiceStub>) => ({
        storage: storageHolding(count, held),
        deviceKeyB64: 'k',
        mlsService,
        log: vi.fn(),
      });
      const proving = createMlsServiceStub();
      const ordinary = createMlsServiceStub();

      await sendHistoryProbe(GROUP, SELF, deps(proving), true);
      await sendHistoryProbe(GROUP, SELF, deps(ordinary));

      expect(sentBodies(proving)[0].incomplete).toBe(true);
      expect('incomplete' in sentBodies(ordinary)[0]).toBe(false);
    }
  );
});

/**
 * A REGISTER OWED ASKS WITH THE DIGEST (`registerOwed.ts`): a state key that matches is answered by
 * silence, which would never deliver the state the push did not bring, so while the marker is set
 * the probe is the digest - whatever the store holds - and it says `register`, on the wire and on
 * the ask this device keeps.
 */
describe('sendHistoryProbe - a register owed', () => {
  beforeEach(() => {
    localStorage.clear();
    forgetHistoryAsks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('sends the DIGEST with `register` even when the store holds something', async () => {
    noteRegisterOwed('user-a', GROUP);
    const mlsService = createMlsServiceStub();
    const held = [
      { id: 'm1', senderId: 'u', content: 'x', timestamp: Date.now() } as StoredMessage,
    ];
    await sendHistoryProbe(GROUP, SELF, {
      storage: storageHolding(1, held),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
    });

    expect(sentEvents(mlsService)).toEqual(['history_digest']);
    const [body] = sentBodies(mlsService);
    expect(body.register).toBe(true);
    expect(typeof body.answerKey).toBe('string');
    expect(takeAddressedAsk(GROUP, body.requestId as string, 'peer:p1', true)?.ask).toMatchObject({
      kind: 'digest',
      register: true,
    });
  });

  it('says nothing of a register once none is owed', async () => {
    noteRegisterOwed('user-a', GROUP);
    clearRegisterOwed('user-a', GROUP, 'register answer');
    const mlsService = createMlsServiceStub();
    await sendHistoryProbe(GROUP, SELF, {
      storage: storageHolding(0),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
    });

    expect('register' in sentBodies(mlsService)[0]).toBe(false);
  });

  it('counts every register ask that left, and goes back to the state key once the bound is spent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteRegisterOwed('user-a', GROUP);
    const held = [
      { id: 'm1', senderId: 'u', content: 'x', timestamp: Date.now() } as StoredMessage,
    ];
    const mlsService = createMlsServiceStub();
    const probe = () =>
      sendHistoryProbe(GROUP, SELF, {
        storage: storageHolding(1, held),
        deviceKeyB64: 'k',
        mlsService,
        log: vi.fn(),
      });

    for (let i = 0; i < REGISTER_ASKS_MAX; i++) await probe();
    expect(isRegisterOwed('user-a', GROUP)).toBe(false);
    await probe();

    expect(sentEvents(mlsService)).toEqual([
      ...Array(REGISTER_ASKS_MAX).fill('history_digest'),
      'history_state',
    ]);
  });

  it('an ask that did not leave is not counted', async () => {
    noteRegisterOwed('user-a', GROUP);
    const mlsService = createMlsServiceStub();
    vi.mocked(mlsService.sendMessage).mockRejectedValue(new Error('offline'));
    for (let i = 0; i < REGISTER_ASKS_MAX + 1; i++) {
      await sendHistoryProbe(GROUP, SELF, {
        storage: storageHolding(0),
        deviceKeyB64: 'k',
        mlsService,
        log: vi.fn(),
      });
    }

    expect(isRegisterOwed('user-a', GROUP)).toBe(true);
  });

  it("is the asking ACCOUNT's marker - another account's owed register asks nothing here", async () => {
    noteRegisterOwed('user-z', GROUP);
    const mlsService = createMlsServiceStub();
    const held = [
      { id: 'm1', senderId: 'u', content: 'x', timestamp: Date.now() } as StoredMessage,
    ];
    await sendHistoryProbe(GROUP, SELF, {
      storage: storageHolding(1, held),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
    });

    expect(sentEvents(mlsService)).toEqual(['history_state']);
  });
});
