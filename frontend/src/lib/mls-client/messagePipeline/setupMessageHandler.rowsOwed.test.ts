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
  /** The context the last system event was dispatched with - its row writers, read by a test. */
  systemCtx: null as null | Record<string, unknown>,
}));
vi.mock('./systemMessageHandler', async (original) => ({
  ...(await original<typeof import('./systemMessageHandler')>()),
  handleSystemEvent: vi.fn(async (_event: string, _data: unknown, ctx: Record<string, unknown>) => {
    seen.owedAtSystemDispatch = seen.owedCount();
    seen.systemCtx = ctx;
  }),
}));

/** A re-add is what a decrypt failure asks; a dispatch that threw must never ask one. */
vi.mock('$lib/utils/chat/recovery', () => ({
  requestReAdd: vi.fn().mockResolvedValue(undefined),
  cancelReAdd: vi.fn(),
  reAddIsInFlight: vi.fn(() => false),
  resetReAddCooldowns: vi.fn(),
}));

import { setupMessageHandler, SYSTEM_EVENTS_OWING_THEIR_ROW } from './setupMessageHandler';
import { requestReAdd } from '$lib/utils/chat/recovery';
import { encodeAppMessage, mkCallHangup, mkReaction, mkSystem, mkText } from '$lib/proto/codec';
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

  it('a message carries its frame id to the row, so only ITS ack waits while the row is unstored', async () => {
    const { d } = deps(ledger, app(mkText('hello')));

    await deliver(d);

    expect(d.addMessageToChat).toHaveBeenCalledWith(
      'peer-user',
      expect.any(String),
      groupId,
      expect.objectContaining({ frameId: 'q1' })
    );
  });

  it('a system event writes its rows - a notice, a history bundle restored - stamped with ITS frame id', async () => {
    const { d } = deps(ledger, app(mkSystem('history_bundle', '{}')));
    const batchAddMessages = vi.fn().mockResolvedValue(undefined);
    const withBatch = { ...d, batchAddMessages };

    await deliver(withBatch);

    const ctx = seen.systemCtx as {
      addMessageToChat: (...a: unknown[]) => Promise<void>;
      batchAddMessages: (...a: unknown[]) => Promise<void>;
    };
    await ctx.batchAddMessages(
      [{ senderId: 'p', content: 'restored', messageId: 'r1' }],
      groupId,
      'restore'
    );
    await ctx.addMessageToChat('system', 'a notice', groupId, { messageId: 'n1' });
    expect(batchAddMessages).toHaveBeenCalledWith(
      [expect.objectContaining({ messageId: 'r1', frameId: 'q1' })],
      groupId,
      'restore'
    );
    expect(d.addMessageToChat).toHaveBeenCalledWith(
      'system',
      'a notice',
      groupId,
      expect.objectContaining({ frameId: 'q1' })
    );
  });

  it.each(['some_event', 'memberRemoved', 'groupDeleted', 'memberAdded', 'history_bundle'])(
    'a system event outside the allowlist (%s): settled BEFORE its dispatch, which may await a checkpoint',
    async (event) => {
      const { d } = deps(ledger, app(mkSystem(event, '{}')));

      expect(await deliver(d)).toBe(true);

      expect(seen.owedAtSystemDispatch).toBe(0);
      expect(ledger.owedCount).toBe(0);
    }
  );

  it.each(['edit_message', 'delete_message'])(
    'a system event that writes rows (%s): owed THROUGH its dispatch, settled once it returned',
    async (event) => {
      const { d } = deps(ledger, app(mkSystem(event, '{}')));

      expect(await deliver(d)).toBe(true);

      // The edit or deletion is written inside the dispatch: a checkpoint waits for it.
      expect(seen.owedAtSystemDispatch).toBe(1);
      expect(ledger.owedCount).toBe(0);
    }
  );

  it('the allowlist is exactly the events read for a checkpoint-free AND request-free path - a history bundle makes HTTP calls before its rows, so it is not on it', () => {
    expect([...SYSTEM_EVENTS_OWING_THEIR_ROW].sort()).toEqual([
      'delete_message',
      'edit_message',
      'remove_reaction',
    ]);
  });

  it('a frame whose decrypt throws settles its mark', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { d } = deps(ledger, () => Promise.reject(new Error('Process error: wrong epoch')));

    await deliver(d);

    expect(ledger.owedCount).toBe(0);
  });

  it('a frame whose add throws settles its mark, is NOT acknowledged and asks NO re-add - it decrypted, the group is healthy', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(requestReAdd).mockClear();
    const { d } = deps(ledger, app(mkText('hello')));
    d.addMessageToChat = vi.fn().mockRejectedValue(new Error('store closed'));

    // `false` is the handler's "do not acknowledge": the server keeps the frame.
    expect(await deliver(d)).toBe(false);

    expect(ledger.owedCount).toBe(0);
    expect(requestReAdd).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalledWith(expect.stringContaining('Out-of-sync'));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('its dispatch THREW'),
      expect.objectContaining({ message: 'store closed' })
    );
  });

  it('any dispatch that throws after the decrypt (a call signal here) is withheld the same way, never read as a decrypt failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(requestReAdd).mockClear();
    const { d } = deps(ledger, app(mkCallHangup('call-1')));
    const withSignal = d as typeof d & { onCallSignal: () => void };
    withSignal.onCallSignal = () => {
      throw new Error('call service torn down');
    };

    expect(await deliver(withSignal)).toBe(false);
    expect(requestReAdd).not.toHaveBeenCalled();
    expect(ledger.owedCount).toBe(0);
  });

  it('a commit takes no mark: it carries no row, and its handler awaits checkpoints of its own', async () => {
    const { d } = deps(ledger, async () => null);

    await deliver(d, true);

    expect(d.mlsService.oweRow).not.toHaveBeenCalled();
  });
});

describe("the Welcome's replay of the frames buffered before it owes each row the same way", () => {
  let ledger: RowsOwedLedger;
  beforeEach(() => {
    localStorage.clear();
    ledger = new RowsOwedLedger();
    seen.owedAtSystemDispatch = -1;
    seen.owedCount = () => ledger.owedCount;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  /** A group this device does not hold yet: a frame is buffered, then its Welcome replays it. */
  function welcomeWorld(frame: Parameters<typeof encodeAppMessage>[0]) {
    let held = false;
    const order: string[] = [];
    const mlsService = createMlsServiceStub({
      getUserGroups: vi.fn().mockResolvedValue([{ groupId, name: 'Test', isGroup: true }]),
      getLocalGroups: vi.fn(() => (held ? [groupId] : [])),
      oweRow: vi.fn(async () => {
        const settle = await ledger.owe();
        order.push('owed');
        return settle;
      }),
      processIncomingMessage: vi.fn(async () => {
        order.push(`decrypt (owed=${ledger.owedCount})`);
        return { plaintext: encodeAppMessage(frame), author: 'unsigned' };
      }),
      processWelcome: vi.fn(async () => {
        held = true;
        return groupId;
      }),
      getDeviceId: vi.fn().mockReturnValue('phone'),
    });
    const d = {
      mlsService,
      storage: null,
      userId: 'user-a',
      deviceKey: () => 'device-key',
      historyBaseUrl: 'https://hist',
      conversations: createTestConversations([]),
      messageReactions: createTestMessageReactions(),
      recoveryTimers: new Map(),
      getSelectedContact: () => null,
      setSelectedContact: vi.fn(),
      saveConversation: vi.fn().mockResolvedValue(undefined),
      addMessageToChat: vi.fn(async () => {
        order.push(`add (owed=${ledger.owedCount})`);
      }),
      loadHistoryForConversation: vi.fn().mockResolvedValue(undefined),
      onGroupReady: vi.fn(),
      log: vi.fn(),
    };
    setupMessageHandler(d as never);
    const onMsg = (mlsService as never as { onMessage: { mock: { calls: unknown[][] } } }).onMessage
      .mock.calls[0][0] as (...args: unknown[]) => Promise<boolean>;
    return { onMsg, order, mlsService, addMessageToChat: d.addMessageToChat };
  }

  it('a buffered message: marked right before its replayed decrypt, owed through its add, settled after', async () => {
    const { onMsg, order } = welcomeWorld(mkText('hello'));

    // Unknown group: buffered and kept in the server queue - no mark, no decrypt yet.
    await onMsg(
      'Peer-User',
      new Uint8Array([7, ++nextFrame]),
      groupId,
      false,
      undefined,
      false,
      LIVE
    );
    expect(order).toEqual([]);

    await onMsg('Peer-User', new Uint8Array([8, ++nextFrame]), groupId, true, undefined, false);

    expect(order).toEqual(['owed', 'decrypt (owed=1)', 'add (owed=1)']);
    expect(ledger.owedCount).toBe(0);
  });

  it("a buffered message's replayed row carries ITS frame id, so a failed write withholds that frame", async () => {
    const { onMsg, addMessageToChat } = welcomeWorld(mkText('hello'));

    await onMsg('Peer-User', new Uint8Array([7, ++nextFrame]), groupId, false, undefined, false, {
      ...LIVE,
      queuedMessageId: 'q-buffered',
    });
    await onMsg('Peer-User', new Uint8Array([8, ++nextFrame]), groupId, true, undefined, false);

    expect(addMessageToChat).toHaveBeenCalledWith(
      'peer-user',
      expect.any(String),
      groupId,
      expect.objectContaining({ frameId: 'q-buffered' })
    );
  });

  it('a buffered system event outside the allowlist: settled BEFORE its replayed dispatch', async () => {
    const { onMsg, order } = welcomeWorld(mkSystem('memberRemoved', '{}'));

    await onMsg(
      'Peer-User',
      new Uint8Array([7, ++nextFrame]),
      groupId,
      false,
      undefined,
      false,
      LIVE
    );
    await onMsg('Peer-User', new Uint8Array([8, ++nextFrame]), groupId, true, undefined, false);

    expect(order).toEqual(['owed', 'decrypt (owed=1)']);
    expect(seen.owedAtSystemDispatch).toBe(0);
    expect(ledger.owedCount).toBe(0);
  });
});
