import { handleSystemEvent } from './systemMessageHandler';
import { digestIdentity } from '$lib/utils/chat/historyDigestRendezvous';
import { WithheldUnsupportedError } from '$lib/mls-client/mlsDeliveryApi';
import {
  forgetHistoryAsks,
  noteHistoryAsk,
  noteJoinSolicited,
} from '$lib/utils/chat/historyAddressing';

/**
 * A BROADCAST `history_bundle` (an older peer, or a server that predates addressed answers) reaches
 * every member, so every member sees an answer meant for one device.
 *
 * Deciding what to do with somebody else's answer used to be delicate: a bundle DISCHARGED the
 * receiver's durable awaiting-history marker, so reading one addressed elsewhere stopped this
 * device's own solicitation on another device's evidence - permanently, since nothing re-armed it.
 * That is why `to` exists.
 *
 * There is no marker any more, and these cases pin what replaced the rule rather than the rule: the
 * messages are taken whoever they were for, because taking them is free and the comparison that
 * decides whether anything is still missing runs again on the next connection.
 */
const ME = 'me';
const MY_DEVICE = 'device-me';
const GROUP = 'g1';

function makeCtx(overrides: Record<string, unknown> = {}) {
  const conversations = new Map<string, any>();
  conversations.set(GROUP, { id: GROUP, unreadCount: 0, messages: [] });
  return {
    mlsService: {
      getDeviceId: () => MY_DEVICE,
      // As the server answers: the caller is counted, an empty entry included.
      getGroupWithheld: vi.fn().mockResolvedValue(new Map([[ME, []]])),
    },
    storage: null,
    userId: ME,
    deviceKey: () => 'device-key',
    conversations,
    messageReactions: new Map(),
    addMessageToChat: vi.fn(),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo: conversations.get(GROUP),
    convoKey: GROUP,
    senderNorm: 'peer',
    persistMlsStateNow: vi.fn(),
    ...overrides,
  };
}

/** One message from the peer, in the wire shape a bundle carries. */
const BUNDLE_MSG = { id: 'm1', senderId: 'peer', content: 'hi', timestamp: 1000 };

describe('history_bundle addressing', () => {
  it('ingests a bundle addressed at THIS device', async () => {
    const ctx = makeCtx();

    await handleSystemEvent(
      'history_bundle',
      { messages: [BUNDLE_MSG], to: digestIdentity(ME, MY_DEVICE) },
      ctx as any
    );

    expect(ctx.batchAddMessages).toHaveBeenCalled();
  });

  it("ingests a bundle answering ANOTHER device's request - the messages are free to take", async () => {
    const ctx = makeCtx();

    await handleSystemEvent(
      'history_bundle',
      { messages: [BUNDLE_MSG], to: digestIdentity('someone-else', 'their-device') },
      ctx as any
    );

    expect(ctx.batchAddMessages).toHaveBeenCalled();
  });

  it('ingests a bundle addressed at another DEVICE of our own user', async () => {
    const ctx = makeCtx();

    await handleSystemEvent(
      'history_bundle',
      { messages: [BUNDLE_MSG], to: digestIdentity(ME, 'another-device-of-mine') },
      ctx as any
    );

    expect(ctx.batchAddMessages).toHaveBeenCalled();
  });

  it('ingests a bundle that names no addressee at all', async () => {
    const ctx = makeCtx();

    await handleSystemEvent('history_bundle', { messages: [BUNDLE_MSG] }, ctx as any);

    expect(ctx.batchAddMessages).toHaveBeenCalled();
  });

  it('merges the conversation state carried by a bundle meant for somebody else', async () => {
    // Read watermarks and the floor are `max` merges and cost nothing to repeat, so an answer
    // passing by is as good a carrier as one addressed here.
    const ctx = makeCtx();

    await handleSystemEvent(
      'history_bundle',
      {
        messages: [],
        to: digestIdentity('someone-else', 'their-device'),
        readWatermarks: { peer: 5000 },
      },
      ctx as any
    );

    expect(ctx.conversations.get(GROUP).readWatermarks).toEqual({ peer: 5000 });
  });
});

/**
 * A REMOVE HOLDS AGAINST A LATER RE-ADD (user, 2026-10-14) - the receiver's half, which is hygiene:
 * a message reaching us from inside OUR OWN exclusion window is dropped, each drop logged.
 */
describe('history_bundle ingestion - our own exclusion windows', () => {
  const OUT_FROM = 10_000;
  const BACK_AT = 20_000;
  const before = {
    id: 'before',
    senderId: 'peer',
    content: 'a',
    timestamp: 1,
    serverTimestamp: 5_000,
  };
  const during = {
    id: 'during',
    senderId: 'peer',
    content: 'b',
    timestamp: 2,
    serverTimestamp: 15_000,
  };
  const after = {
    id: 'after',
    senderId: 'peer',
    content: 'c',
    timestamp: 3,
    serverTimestamp: 25_000,
  };

  function ctxWithWindows(windows: Map<string, unknown>, queuedCreatedAt = 1_000_000) {
    return makeCtx({
      mlsService: {
        getDeviceId: () => MY_DEVICE,
        getGroupWithheld: vi.fn().mockResolvedValue(windows),
      },
      // The server's own time for the bundle frame: what a relayed server time must lie below.
      deliveryMeta: { queuedCreatedAt },
    });
  }

  // A relayed server time AFTER the bundle frame's own is a claim the server never made: the row
  // loses it and is placed by its sentAt (`vettedBundleServerTime`), so it cannot be the order key
  // or the read-mark key of a time that has not come.
  it("drops a row's server time dated after the bundle frame itself", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = ctxWithWindows(new Map([[ME, []]]), 20_000);

    await handleSystemEvent('history_bundle', { messages: [before, after] }, ctx as any);

    const added = ctx.batchAddMessages.mock.calls[0][0] as Array<{
      messageId: string;
      serverTimestamp?: number;
    }>;
    expect(added.find((m) => m.messageId === 'before')?.serverTimestamp).toBe(5_000);
    expect(added.find((m) => m.messageId === 'after')?.serverTimestamp).toBeUndefined();
  });

  it('drops what was sent while we were out, keeps what preceded and followed it', async () => {
    const ctx = ctxWithWindows(new Map([[ME, [{ from: OUT_FROM, until: BACK_AT }]]]));

    await handleSystemEvent('history_bundle', { messages: [before, during, after] }, ctx as any);

    const added = (ctx.batchAddMessages.mock.calls[0][0] as Array<{ messageId: string }>).map(
      (m) => m.messageId
    );
    expect(added).toEqual(['before', 'after']);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('Dropped during'));
  });

  it('a newcomer drops what was sent before it arrived - a broadcast answer meant for another device', async () => {
    // Our withheld span (user, 2026-10-21): everything before we were added to the group.
    const ctx = ctxWithWindows(new Map([[ME, [{ from: 0, until: 10_000 }]]]));

    await handleSystemEvent('history_bundle', { messages: [before, during, after] }, ctx as any);

    const added = (ctx.batchAddMessages.mock.calls[0][0] as Array<{ messageId: string }>).map(
      (m) => m.messageId
    );
    expect(added).toEqual(['during', 'after']);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('Dropped before'));
  });

  it("another member's window is not ours to apply - the answering peer enforces that", async () => {
    const ctx = ctxWithWindows(
      new Map([
        [ME, []],
        ['someone-else', [{ from: OUT_FROM, until: BACK_AT }]],
      ])
    );

    await handleSystemEvent('history_bundle', { messages: [before, during, after] }, ctx as any);

    expect(ctx.batchAddMessages.mock.calls[0][0]).toHaveLength(3);
  });

  it('ingests no message when the server does not count us - a missing entry is no empty set', async () => {
    const ctx = ctxWithWindows(new Map());

    await handleSystemEvent('history_bundle', { messages: [before] }, ctx as any);

    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('does not count me'));
  });

  it('keeps its old rule, our own gaps, against a server that predates `withheld`', async () => {
    const ctx = makeCtx({
      mlsService: {
        getDeviceId: () => MY_DEVICE,
        getGroupWithheld: vi.fn().mockRejectedValue(new WithheldUnsupportedError(GROUP)),
        getGroupExclusions: vi
          .fn()
          .mockResolvedValue(new Map([[ME, [{ from: OUT_FROM, until: BACK_AT }]]])),
      },
      deliveryMeta: { queuedCreatedAt: 1_000_000 },
    });

    await handleSystemEvent('history_bundle', { messages: [before, during, after] }, ctx as any);

    const added = (ctx.batchAddMessages.mock.calls[0][0] as Array<{ messageId: string }>).map(
      (m) => m.messageId
    );
    expect(added).toEqual(['before', 'after']);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('predates the withheld windows'));
  });

  it('ingests no message when our windows cannot be read, and says so', async () => {
    const ctx = makeCtx({
      mlsService: {
        getDeviceId: () => MY_DEVICE,
        getGroupWithheld: vi.fn().mockRejectedValue(new Error('503')),
      },
    });

    await handleSystemEvent('history_bundle', { messages: [before] }, ctx as any);

    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      expect.stringContaining('ingesting none of these messages')
    );
  });

  it('drops an UNDATED message by the rule the sender applies - near the window by its own clock', async () => {
    const ctx = ctxWithWindows(new Map([[ME, [{ from: OUT_FROM, until: BACK_AT }]]]));
    const undatedNear = { id: 'undated-near', senderId: 'peer', content: 'd', timestamp: 15_000 };
    const undatedFar = {
      id: 'undated-far',
      senderId: 'peer',
      content: 'e',
      timestamp: BACK_AT + 2 * 60 * 60 * 1000,
    };

    await handleSystemEvent('history_bundle', { messages: [undatedNear, undatedFar] }, ctx as any);

    const added = (ctx.batchAddMessages.mock.calls[0][0] as Array<{ messageId: string }>).map(
      (m) => m.messageId
    );
    expect(added).toEqual(['undated-far']);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('(undated-near-window)'));
  });
});

/**
 * STEP A, RULE 5 (docs/wiki/protocols/history-answer-addressing.md): an ADDRESSED bundle reached this
 * device alone, so it is believed only as the answer to an ask this device made - and only for what
 * that ask asked, and only to ADD messages.
 */
describe('history_bundle - an addressed answer is the answer to OUR ask or nothing', () => {
  const ADDRESSED = {
    deliveryMeta: { channel: 'live', addressed: true, senderDeviceId: 'responder-1' },
  };
  const TO_ME = digestIdentity(ME, MY_DEVICE);
  const ASKED_AT = 1_700_000_000_000;

  beforeEach(() => forgetHistoryAsks());

  function refusedLines(error: { mock: { calls: unknown[][] } }) {
    return error.mock.calls.filter(([l]) => String(l).includes('[HISTORY_ADDRESSED] REFUSED'));
  }

  it('ingests the answer to an open ask', async () => {
    noteHistoryAsk(GROUP, 'req-00000001', { kind: 'digest', since: 0, askedAt: ASKED_AT });
    const ctx = makeCtx(ADDRESSED);

    await handleSystemEvent(
      'history_bundle',
      { messages: [BUNDLE_MSG], to: TO_ME, requestId: 'req-00000001', last: true },
      ctx as any
    );

    expect(ctx.batchAddMessages).toHaveBeenCalled();
  });

  it('refuses one that names no ask, one that names an ask we never made, and one for another device', async () => {
    noteHistoryAsk(GROUP, 'req-00000001', { kind: 'digest', since: 0, askedAt: ASKED_AT });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx(ADDRESSED);

    await handleSystemEvent('history_bundle', { messages: [BUNDLE_MSG], to: TO_ME }, ctx as any);
    await handleSystemEvent(
      'history_bundle',
      { messages: [BUNDLE_MSG], to: TO_ME, requestId: 'req-99999999' },
      ctx as any
    );
    await handleSystemEvent(
      'history_bundle',
      {
        messages: [BUNDLE_MSG],
        to: digestIdentity(ME, 'another-device'),
        requestId: 'req-00000001',
      },
      ctx as any
    );

    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
    expect(refusedLines(error)).toHaveLength(3);
    error.mockRestore();
  });

  it('the chunk marked `last` closes the ask - a later chunk naming it is refused', async () => {
    noteHistoryAsk(GROUP, 'req-00000001', { kind: 'digest', since: 0, askedAt: ASKED_AT });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx(ADDRESSED);
    const frame = { messages: [BUNDLE_MSG], to: TO_ME, requestId: 'req-00000001', last: true };

    await handleSystemEvent('history_bundle', frame, ctx as any);
    await handleSystemEvent('history_bundle', frame, ctx as any);

    expect(ctx.batchAddMessages).toHaveBeenCalledTimes(1);
    expect(refusedLines(error)).toHaveLength(1);
    error.mockRestore();
  });

  /**
   * Review of #2270: the rendezvous can hand one ask to a second responder (a re-election over a
   * stored probe). Its answer is held to the same bound and ADDS the same way, so refusing it at
   * error was noise that could lose content - an ask is closed per answering DEVICE.
   */
  it('a second responder to the same ask is ingested - the ask is closed per answering device', async () => {
    noteHistoryAsk(GROUP, 'req-00000001', { kind: 'digest', since: 0, askedAt: ASKED_AT });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const frame = { messages: [BUNDLE_MSG], to: TO_ME, requestId: 'req-00000001', last: true };
    const first = makeCtx(ADDRESSED);
    const second = makeCtx({
      deliveryMeta: { ...ADDRESSED.deliveryMeta, senderDeviceId: 'responder-2' },
    });

    await handleSystemEvent('history_bundle', frame, first as any);
    await handleSystemEvent('history_bundle', frame, second as any);

    expect(first.batchAddMessages).toHaveBeenCalledTimes(1);
    expect(second.batchAddMessages).toHaveBeenCalledTimes(1);
    expect(refusedLines(error)).toHaveLength(0);
    error.mockRestore();
  });

  /**
   * Re-review of #2270: the answerer an ask is closed for must be the device MLS verified. The live
   * and pull paths check the envelope's device against the credential only when the envelope names
   * one, so an addressed answer that names none is refused rather than keyed on nothing.
   */
  it('refuses an addressed answer whose envelope names no sending device', async () => {
    noteHistoryAsk(GROUP, 'req-00000001', { kind: 'digest', since: 0, askedAt: ASKED_AT });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx({ deliveryMeta: { channel: 'live', addressed: true } });

    await handleSystemEvent(
      'history_bundle',
      { messages: [BUNDLE_MSG], to: TO_ME, requestId: 'req-00000001', last: true },
      ctx as any
    );

    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
    expect(refusedLines(error)).toHaveLength(1);
    error.mockRestore();
  });

  it('drops, at error, what lies outside the range we asked for', async () => {
    noteHistoryAsk(GROUP, 'req-00000002', {
      kind: 'range',
      since: 500,
      before: 2000,
      askedAt: ASKED_AT,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx(ADDRESSED);
    const newer = { ...BUNDLE_MSG, id: 'newer', timestamp: 2000 };

    await handleSystemEvent(
      'history_bundle',
      { messages: [BUNDLE_MSG, newer], to: TO_ME, requestId: 'req-00000002', last: true },
      ctx as any
    );

    const added = (ctx.batchAddMessages.mock.calls[0][0] as Array<{ messageId: string }>).map(
      (m) => m.messageId
    );
    expect(added).toEqual(['m1']);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('1 message(s) of an addressed range')
    );
    error.mockRestore();
  });

  it('an answer to an ask only ADDS - it merges no read state', async () => {
    noteHistoryAsk(GROUP, 'req-00000001', { kind: 'digest', since: 0, askedAt: ASKED_AT });
    const ctx = makeCtx(ADDRESSED);

    await handleSystemEvent(
      'history_bundle',
      {
        messages: [],
        to: TO_ME,
        requestId: 'req-00000001',
        last: true,
        readWatermarks: { peer: 5000 },
      },
      ctx as any
    );

    expect(ctx.conversations.get(GROUP).readWatermarks).toBeUndefined();
  });

  it("the inviter's push is solicited by our admission, and may hand over the conversation state", async () => {
    noteJoinSolicited(GROUP, ASKED_AT);
    const ctx = makeCtx(ADDRESSED);

    await handleSystemEvent(
      'history_bundle',
      {
        messages: [BUNDLE_MSG],
        to: TO_ME,
        join: true,
        last: true,
        readWatermarks: { peer: 5000 },
      },
      ctx as any
    );

    expect(ctx.batchAddMessages).toHaveBeenCalled();
    expect(ctx.conversations.get(GROUP).readWatermarks).toEqual({ peer: 5000 });
  });

  it('a push to a device that was admitted to nothing is refused', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx(ADDRESSED);

    await handleSystemEvent(
      'history_bundle',
      { messages: [BUNDLE_MSG], to: TO_ME, join: true, last: true },
      ctx as any
    );

    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
    expect(refusedLines(error)).toHaveLength(1);
    error.mockRestore();
  });
});
