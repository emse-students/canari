// @vitest-environment happy-dom
/**
 * ROWS BEFORE RATCHET, THE DECRYPT HALF (docs/wiki/frontend/modules/chat.md): an application
 * frame's row is OWED from right before its decrypt to its write, so a checkpoint - which waits for
 * every owed row before it exports - never claims a ratchet advance whose row is neither stored nor
 * buffered. The mark must never span work that may await a checkpoint (a system event, an eviction),
 * or that checkpoint would wait for it: settled BEFORE those, and a commit takes none.
 */
vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
  saveMlsStateEncrypted: vi.fn().mockResolvedValue(undefined),
  purgeLegacyPlainMlsState: vi.fn().mockResolvedValue(undefined),
}));

/** The ledger the handler marks in, read by the system-event mock at the moment of its dispatch. */
const seen = vi.hoisted(() => ({
  owedAtSystemDispatch: -1 as number,
  owedCount: (): number => -1,
}));
vi.mock('./systemMessageHandler', async (original) => ({
  ...(await original<typeof import('./systemMessageHandler')>()),
  handleSystemEvent: vi.fn(async () => {
    seen.owedAtSystemDispatch = seen.owedCount();
  }),
}));

import { setupMessageHandler, SYSTEM_EVENTS_OWING_THEIR_ROW } from './setupMessageHandler';
import { encodeAppMessage, mkReaction, mkSystem, mkText } from '$lib/proto/codec';
import type { IncomingDeliveryMeta } from '../incomingDelivery';
import { RowsOwedLedger } from '../rowsOwed';
import { createMlsServiceStub } from '../test/fixtures/mlsServiceStub';
import {
  createTestConversations,
  createTestMessageReactions,
  emptyConversation,
} from '../test/fixtures/conversationMap';

const groupId = '55555555-5555-4555-8555-555555555555';
const LIVE: IncomingDeliveryMeta = {
  channel: 'live',
  senderDeviceId: 'dev-p',
  queuedMessageId: 'q1',
};

/** Distinct bytes per delivery: the frame ring outlives a test. */
let nextFrame = 0;

function deps(ledger: RowsOwedLedger, opened: () => Promise<unknown>) {
  const order: string[] = [];
  const d = {
    mlsService: createMlsServiceStub({
      getUserGroups: vi.fn().mockResolvedValue([{ groupId, name: 'Test', isGroup: true }]),
      getLocalGroups: vi.fn().mockReturnValue([groupId]),
      oweRow: vi.fn(async () => {
        const settle = await ledger.owe();
        order.push('owed');
        return settle;
      }),
      processIncomingMessage: vi.fn(async () => {
        order.push(`decrypt (owed=${ledger.owedCount})`);
        return opened();
      }),
    }),
    storage: null,
    userId: 'user-a',
    deviceKey: () => 'device-key',
    historyBaseUrl: 'https://hist',
    conversations: createTestConversations([
      [groupId, emptyConversation(groupId, { lifecycle: 'active' })],
    ]),
    messageReactions: createTestMessageReactions(),
    recoveryTimers: new Map(),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    addMessageToChat: vi.fn(async () => {
      order.push(`add (owed=${ledger.owedCount})`);
    }),
    loadHistoryForConversation: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  };
  return { d, order };
}

function deliver(d: ReturnType<typeof deps>['d'], isCommit = false): Promise<boolean> {
  setupMessageHandler(d as never);
  const onMsg = (d.mlsService as never as { onMessage: { mock: { calls: unknown[][] } } }).onMessage
    .mock.calls[0][0] as (...args: unknown[]) => Promise<boolean>;
  return onMsg(
    'Peer-User',
    new Uint8Array([9, ++nextFrame]),
    groupId,
    false,
    undefined,
    isCommit,
    LIVE
  );
}

const app = (msg: Parameters<typeof encodeAppMessage>[0]) => async () => ({
  plaintext: encodeAppMessage(msg),
  author: 'unsigned',
});

describe('an application frame owes its row from its decrypt to its write', () => {
  let ledger: RowsOwedLedger;
  beforeEach(() => {
    localStorage.clear();
    ledger = new RowsOwedLedger();
    seen.owedAtSystemDispatch = -1;
    seen.owedCount = () => ledger.owedCount;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('a message: marked before the decrypt, still owed while it is added, settled once the add returned', async () => {
    const { d, order } = deps(ledger, app(mkText('hello')));

    expect(await deliver(d)).toBe(true);

    expect(order).toEqual(['owed', 'decrypt (owed=1)', 'add (owed=1)']);
    expect(ledger.owedCount).toBe(0);
  });

  it('a checkpoint taken while the row is being written exports only after the write', async () => {
    let finishAdd!: () => void;
    const { d } = deps(ledger, app(mkText('hello')));
    d.addMessageToChat = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishAdd = resolve;
        })
    );

    const handled = deliver(d);
    await vi.waitFor(() => expect(d.addMessageToChat).toHaveBeenCalled());
    let exported = false;
    const hold = ledger.hold().then((release) => {
      exported = true;
      return release;
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(exported).toBe(false);
    finishAdd();
    await handled;
    (await hold)();
    expect(exported).toBe(true);
  });

  it('a decrypt asked while a checkpoint holds waits for its release - it never decrypts under the export', async () => {
    const { d, order } = deps(ledger, app(mkText('hello')));
    const release = await ledger.hold();

    const handled = deliver(d);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await handled;
    expect(order).toEqual(['owed', 'decrypt (owed=1)', 'add (owed=1)']);
  });

  it('a reaction: owed until the reaction is applied, then settled', async () => {
    const { d } = deps(ledger, app(mkReaction('m1', '+1', 1000)));

    expect(await deliver(d)).toBe(true);
    expect(ledger.owedCount).toBe(0);
  });

  it.each(['some_event', 'memberRemoved', 'groupDeleted', 'memberAdded'])(
    'a system event outside the allowlist (%s): settled BEFORE its dispatch, which may await a checkpoint',
    async (event) => {
      const { d } = deps(ledger, app(mkSystem(event, '{}')));

      expect(await deliver(d)).toBe(true);

      expect(seen.owedAtSystemDispatch).toBe(0);
      expect(ledger.owedCount).toBe(0);
    }
  );

  it.each(['edit_message', 'delete_message', 'history_bundle'])(
    'a system event that writes rows (%s): owed THROUGH its dispatch, settled once it returned',
    async (event) => {
      const { d } = deps(ledger, app(mkSystem(event, '{}')));

      expect(await deliver(d)).toBe(true);

      // The edit, deletion or bundle is written inside the dispatch: a checkpoint waits for it.
      expect(seen.owedAtSystemDispatch).toBe(1);
      expect(ledger.owedCount).toBe(0);
    }
  );

  it('the allowlist is exactly the events read for a checkpoint-free path - adding one means reading it first', () => {
    expect([...SYSTEM_EVENTS_OWING_THEIR_ROW].sort()).toEqual([
      'delete_message',
      'edit_message',
      'history_bundle',
    ]);
  });

  it('a frame whose decrypt throws settles its mark', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { d } = deps(ledger, () => Promise.reject(new Error('Process error: wrong epoch')));

    await deliver(d);

    expect(ledger.owedCount).toBe(0);
  });

  it('a frame whose add throws settles its mark', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { d } = deps(ledger, app(mkText('hello')));
    d.addMessageToChat = vi.fn().mockRejectedValue(new Error('store closed'));

    await deliver(d);

    expect(ledger.owedCount).toBe(0);
  });

  it('a commit takes no mark: it carries no row, and its handler awaits checkpoints of its own', async () => {
    const { d } = deps(ledger, async () => null);

    await deliver(d, true);

    expect(d.mlsService.oweRow).not.toHaveBeenCalled();
  });
});
