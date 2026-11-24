import { handleSystemEvent } from './systemMessageHandler';
import {
  historySealAad,
  mintHistoryAnswerKey,
  sealHistoryContent,
  type HistoryAnswerKey,
} from '$lib/crypto/historySeal';
import { fakeHistorySealEngine } from '$lib/mls-client/test/fixtures/fakeHistorySealEngine';
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
/** The seal's refusals without its cryptography (`fakeHistorySealEngine`). */
const sealEngine = fakeHistorySealEngine();

function makeCtx(overrides: Record<string, unknown> = {}) {
  const conversations = new Map<string, any>();
  conversations.set(GROUP, { id: GROUP, unreadCount: 0, messages: [] });
  return {
    mlsService: {
      getDeviceId: () => MY_DEVICE,
      historySealEngine: () => sealEngine,
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

  beforeEach(() => {
    forgetHistoryAsks();
    keys.clear();
  });

  /**
   * The key of each ask this device made: every ask carries one since the floor reached option B
   * (`1.7.0`), so every answer below is sealed to it, as an answerer at the floor sends it.
   */
  const keys = new Map<string, HistoryAnswerKey>();

  /** Records our ask `requestId`, with the key it carried. */
  async function ask(requestId: string, what: Parameters<typeof noteHistoryAsk>[2]): Promise<void> {
    const key = await mintHistoryAnswerKey(sealEngine);
    keys.set(requestId, key);
    noteHistoryAsk(GROUP, requestId, what, key.secret);
  }

  /** `frame` as `peer` on `device` answers our ask: the routing in clear, the rest sealed to it. */
  async function answer(
    frame: Record<string, unknown> & { requestId: string },
    device = 'responder-1'
  ): Promise<Record<string, unknown>> {
    const { to, requestId, last, ...content } = frame;
    const sealed = await sealHistoryContent(
      sealEngine,
      keys.get(requestId)!.answerKey,
      historySealAad(GROUP, requestId, String(to), digestIdentity('peer', device)),
      content
    );
    return { to, requestId, ...(last !== undefined ? { last } : {}), sealed };
  }

  function refusedLines(error: { mock: { calls: unknown[][] } }) {
    return error.mock.calls.filter(([l]) => String(l).includes('[HISTORY_ADDRESSED] REFUSED'));
  }

  it('ingests the answer to an open ask', async () => {
    await ask('req-00000001', { kind: 'digest', since: 0, askedAt: ASKED_AT });
    const ctx = makeCtx(ADDRESSED);

    await handleSystemEvent(
      'history_bundle',
      await answer({ messages: [BUNDLE_MSG], to: TO_ME, requestId: 'req-00000001', last: true }),
      ctx as any
    );

    expect(ctx.batchAddMessages).toHaveBeenCalled();
  });

  it('refuses one that names no ask, one that names an ask we never made, and one for another device', async () => {
    await ask('req-00000001', { kind: 'digest', since: 0, askedAt: ASKED_AT });
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
    // Each cause by its NAME, classified where it is decided.
    const reasons = refusedLines(error).map(([l]) => String(l));
    expect(reasons).toHaveLength(3);
    expect(reasons[0]).toContain(' - names-no-ask ');
    expect(reasons[1]).toContain(' - no-open-ask ');
    expect(reasons[2]).toContain(' - not-addressed-to-us ');
    error.mockRestore();
  });

  it('the chunk marked `last` closes the ask - a later chunk naming it is refused', async () => {
    await ask('req-00000001', { kind: 'digest', since: 0, askedAt: ASKED_AT });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx(ADDRESSED);
    const frame = await answer({
      messages: [BUNDLE_MSG],
      to: TO_ME,
      requestId: 'req-00000001',
      last: true,
    });

    await handleSystemEvent('history_bundle', frame, ctx as any);
    await handleSystemEvent('history_bundle', frame, ctx as any);

    expect(ctx.batchAddMessages).toHaveBeenCalledTimes(1);
    // While the ask is open for its other answerer slot: the same device's second copy, by name.
    expect(refusedLines(error).map(([l]) => String(l))).toEqual([
      expect.stringContaining(' - answered-already '),
    ]);
    error.mockRestore();
  });

  /**
   * Review of #2270: the rendezvous can hand one ask to a second responder (a re-election over a
   * stored probe). Its answer is held to the same bound and ADDS the same way, so refusing it at
   * error was noise that could lose content - an ask is closed per answering DEVICE.
   */
  it('a second responder to the same ask is ingested - the ask is closed per answering device', async () => {
    await ask('req-00000001', { kind: 'digest', since: 0, askedAt: ASKED_AT });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const frame = { messages: [BUNDLE_MSG], to: TO_ME, requestId: 'req-00000001', last: true };
    const first = makeCtx(ADDRESSED);
    const second = makeCtx({
      deliveryMeta: { ...ADDRESSED.deliveryMeta, senderDeviceId: 'responder-2' },
    });

    await handleSystemEvent('history_bundle', await answer(frame), first as any);
    await handleSystemEvent('history_bundle', await answer(frame, 'responder-2'), second as any);

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
    await ask('req-00000001', { kind: 'digest', since: 0, askedAt: ASKED_AT });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx({ deliveryMeta: { channel: 'live', addressed: true } });

    await handleSystemEvent(
      'history_bundle',
      { messages: [BUNDLE_MSG], to: TO_ME, requestId: 'req-00000001', last: true },
      ctx as any
    );

    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
    expect(refusedLines(error).map(([l]) => String(l))).toEqual([
      expect.stringContaining(' - no-sending-device '),
    ]);
    error.mockRestore();
  });

  it('drops, at error, what lies outside the range we asked for', async () => {
    await ask('req-00000002', { kind: 'range', since: 500, before: 2000, askedAt: ASKED_AT });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx(ADDRESSED);
    const newer = { ...BUNDLE_MSG, id: 'newer', timestamp: 2000 };

    await handleSystemEvent(
      'history_bundle',
      await answer({
        messages: [BUNDLE_MSG, newer],
        to: TO_ME,
        requestId: 'req-00000002',
        last: true,
      }),
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
    await ask('req-00000001', { kind: 'digest', since: 0, askedAt: ASKED_AT });
    const ctx = makeCtx(ADDRESSED);

    await handleSystemEvent(
      'history_bundle',
      await answer({
        messages: [],
        to: TO_ME,
        requestId: 'req-00000001',
        last: true,
        readWatermarks: { peer: 5000 },
      }),
      ctx as any
    );

    expect(ctx.conversations.get(GROUP).readWatermarks).toBeUndefined();
  });

  it('a join push from a member the Welcome did not come from is refused - it could set the floor', async () => {
    noteJoinSolicited(GROUP, 'inviter', ASKED_AT);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
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

    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
    expect(ctx.conversations.get(GROUP).readWatermarks).toBeUndefined();
    expect(error.mock.calls.join(' ')).toContain('REFUSED an addressed history_bundle');
    error.mockRestore();
  });

  it("the inviter's push is solicited by our admission, and may hand over the conversation state", async () => {
    noteJoinSolicited(GROUP, 'peer', ASKED_AT);
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

/**
 * Option B (docs/wiki/protocols/history-answer-addressing.md, "Sealing the answer to the asker"): an
 * ask that carried a key is answered with its content sealed to it, bound to the conversation, the
 * ask, the asker and the answering device - so a frame the server hands to the wrong device, or a
 * member relays under its own name, is read by nobody but the asker.
 */
describe('history_bundle - an answer sealed to our ask', () => {
  const ANSWERER_DEVICE = 'responder-1';
  const ADDRESSED = {
    deliveryMeta: { channel: 'live', addressed: true, senderDeviceId: ANSWERER_DEVICE },
  };
  const TO_ME = digestIdentity(ME, MY_DEVICE);
  /** The answerer as the seal binds it: its user AND its device (`digestIdentity`). */
  const ANSWERER = digestIdentity('peer', ANSWERER_DEVICE);
  const ASKED_AT = 1_700_000_000_000;
  const REQUEST = 'req-00000001';

  beforeEach(() => forgetHistoryAsks());

  /** Opens our ask with a key, and seals `content` the way an answerer bound to `aad` would. */
  async function sealedAnswer(
    content: Record<string, unknown>,
    aad = historySealAad(GROUP, REQUEST, TO_ME, ANSWERER)
  ): Promise<string> {
    const key = await mintHistoryAnswerKey(sealEngine);
    noteHistoryAsk(GROUP, REQUEST, { kind: 'digest', since: 0, askedAt: ASKED_AT }, key.secret);
    return sealHistoryContent(sealEngine, key.answerKey, aad, content);
  }

  function lines(error: { mock: { calls: unknown[][] } }, needle: string) {
    return error.mock.calls.filter(([l]) => String(l).includes(needle));
  }

  it('opens the sealed content with the secret kept beside the ask, and ingests it', async () => {
    const sealed = await sealedAnswer({ messages: [BUNDLE_MSG] });
    const ctx = makeCtx(ADDRESSED);

    await handleSystemEvent(
      'history_bundle',
      { to: TO_ME, requestId: REQUEST, last: true, sealed },
      ctx as any
    );

    const added = (ctx.batchAddMessages.mock.calls[0][0] as Array<{ messageId: string }>).map(
      (m) => m.messageId
    );
    expect(added).toEqual(['m1']);
  });

  it('refuses at error a sealed answer bound to ANOTHER answering device - a relayed answer', async () => {
    const sealed = await sealedAnswer(
      { messages: [BUNDLE_MSG] },
      historySealAad(GROUP, REQUEST, TO_ME, digestIdentity('peer', 'another-device'))
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx(ADDRESSED);

    await handleSystemEvent(
      'history_bundle',
      { to: TO_ME, requestId: REQUEST, last: true, sealed },
      ctx as any
    );

    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
    expect(lines(error, 'does not open under our ask (refused)')).toHaveLength(1);
    error.mockRestore();
  });

  it('refuses a sealed answer bound to the same device id under ANOTHER user - the AAD names both', async () => {
    const sealed = await sealedAnswer(
      { messages: [BUNDLE_MSG] },
      historySealAad(GROUP, REQUEST, TO_ME, digestIdentity('mallory', ANSWERER_DEVICE))
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx(ADDRESSED);

    await handleSystemEvent(
      'history_bundle',
      { to: TO_ME, requestId: REQUEST, last: true, sealed },
      ctx as any
    );

    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
    expect(lines(error, 'does not open under our ask (refused)')).toHaveLength(1);
    error.mockRestore();
  });

  it('bytes that do not open take NO answerer slot - the honest answers after them still land', async () => {
    const key = await mintHistoryAnswerKey(sealEngine);
    noteHistoryAsk(GROUP, REQUEST, { kind: 'digest', since: 0, askedAt: ASKED_AT }, key.secret);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Two forgeries from two devices: under take-then-open they would fill both answerer slots.
    for (const device of ['forger-1', 'forger-2']) {
      const forged = await sealHistoryContent(
        sealEngine,
        key.answerKey,
        historySealAad(GROUP, REQUEST, TO_ME, digestIdentity('peer', 'not-' + device)),
        { messages: [{ ...BUNDLE_MSG, id: 'forged-' + device }] }
      );
      await handleSystemEvent(
        'history_bundle',
        { to: TO_ME, requestId: REQUEST, last: false, sealed: forged },
        makeCtx({ deliveryMeta: { ...ADDRESSED.deliveryMeta, senderDeviceId: device } }) as any
      );
    }
    const honest = await sealHistoryContent(
      sealEngine,
      key.answerKey,
      historySealAad(GROUP, REQUEST, TO_ME, ANSWERER),
      { messages: [BUNDLE_MSG] }
    );
    const ctx = makeCtx(ADDRESSED);

    await handleSystemEvent(
      'history_bundle',
      { to: TO_ME, requestId: REQUEST, last: true, sealed: honest },
      ctx as any
    );

    expect(lines(error, 'does not open under our ask')).toHaveLength(2);
    const added = (ctx.batchAddMessages.mock.calls[0][0] as Array<{ messageId: string }>).map(
      (m) => m.messageId
    );
    expect(added).toEqual(['m1']);
    error.mockRestore();
  });

  it('OUR engine failing to open is said apart from bytes that do not open - a defect of this build', async () => {
    const key = await mintHistoryAnswerKey(sealEngine);
    noteHistoryAsk(GROUP, REQUEST, { kind: 'digest', since: 0, askedAt: ASKED_AT }, key.secret);
    const sealed = await sealHistoryContent(
      sealEngine,
      key.answerKey,
      historySealAad(GROUP, REQUEST, TO_ME, ANSWERER),
      { messages: [BUNDLE_MSG] }
    );
    const broken = {
      ...sealEngine,
      open: () => Promise.reject(new Error('the bridge is gone')),
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx(ADDRESSED);
    ctx.mlsService.historySealEngine = () => broken;

    await handleSystemEvent(
      'history_bundle',
      { to: TO_ME, requestId: REQUEST, last: true, sealed },
      ctx as any
    );

    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
    expect(lines(error, '[HISTORY_SEAL] OUR engine failed to open')).toHaveLength(1);
    expect(lines(error, 'does not open under our ask')).toHaveLength(0);
    error.mockRestore();
  });

  it('a sealed answer still holds to the bound of its ask', async () => {
    const key = await mintHistoryAnswerKey(sealEngine);
    noteHistoryAsk(
      GROUP,
      REQUEST,
      { kind: 'range', since: 500, before: 2000, askedAt: ASKED_AT },
      key.secret
    );
    const sealed = await sealHistoryContent(
      sealEngine,
      key.answerKey,
      historySealAad(GROUP, REQUEST, TO_ME, ANSWERER),
      { messages: [BUNDLE_MSG, { ...BUNDLE_MSG, id: 'newer', timestamp: 2000 }] }
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx(ADDRESSED);

    await handleSystemEvent(
      'history_bundle',
      { to: TO_ME, requestId: REQUEST, last: true, sealed },
      ctx as any
    );

    const added = (ctx.batchAddMessages.mock.calls[0][0] as Array<{ messageId: string }>).map(
      (m) => m.messageId
    );
    expect(added).toEqual(['m1']);
    error.mockRestore();
  });

  it('refuses a sealed join push and a sealed broadcast - nothing honest seals either', async () => {
    noteJoinSolicited(GROUP, 'peer', ASKED_AT);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pushed = makeCtx(ADDRESSED);
    const broadcast = makeCtx();

    await handleSystemEvent(
      'history_bundle',
      { to: TO_ME, join: true, last: true, sealed: 'AAAA' },
      pushed as any
    );
    await handleSystemEvent(
      'history_bundle',
      { to: TO_ME, requestId: REQUEST, sealed: 'AAAA' },
      broadcast as any
    );

    expect(pushed.batchAddMessages).not.toHaveBeenCalled();
    expect(broadcast.batchAddMessages).not.toHaveBeenCalled();
    expect(lines(error, 'carried no key')).toHaveLength(1);
    expect(lines(error, 'it was not addressed')).toHaveLength(1);
    error.mockRestore();
  });

  /**
   * Every build at the floor (`1.7.0`) seals its answer to a keyed ask (option B), so one in clear is
   * a defect or a forgery: refused at error, every time, and nothing of it ingested
   * (docs/wiki/legacy-compatibility.md history - the `[LEGACY]` acceptance is gone).
   */
  it('refuses at error an UNSEALED answer to a keyed ask, every time', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const id of [REQUEST, 'req-00000002']) {
      const key = await mintHistoryAnswerKey(sealEngine);
      noteHistoryAsk(GROUP, id, { kind: 'digest', since: 0, askedAt: ASKED_AT }, key.secret);
    }
    const ctx = makeCtx(ADDRESSED);

    for (const id of [REQUEST, 'req-00000002']) {
      await handleSystemEvent(
        'history_bundle',
        { messages: [BUNDLE_MSG], to: TO_ME, requestId: id, last: true },
        ctx as any
      );
    }

    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
    expect(lines(error, 'REFUSED an unsealed history_bundle')).toHaveLength(2);
    expect(lines(error, '[LEGACY]')).toHaveLength(0);
    error.mockRestore();
  });

  it('an unsealed answer takes NO answerer slot - the honest sealed answer after it still lands', async () => {
    const key = await mintHistoryAnswerKey(sealEngine);
    noteHistoryAsk(GROUP, REQUEST, { kind: 'digest', since: 0, askedAt: ASKED_AT }, key.secret);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Two clear `last` chunks from two devices that read the ask's id: taken first, they would fill
    // both answerer slots and close the ask before the honest answer arrives.
    for (const device of ['clear-1', 'clear-2']) {
      await handleSystemEvent(
        'history_bundle',
        {
          messages: [{ ...BUNDLE_MSG, id: 'clear-' + device }],
          to: TO_ME,
          requestId: REQUEST,
          last: true,
        },
        makeCtx({ deliveryMeta: { ...ADDRESSED.deliveryMeta, senderDeviceId: device } }) as any
      );
    }
    const honest = await sealHistoryContent(
      sealEngine,
      key.answerKey,
      historySealAad(GROUP, REQUEST, TO_ME, ANSWERER),
      { messages: [BUNDLE_MSG] }
    );
    const ctx = makeCtx(ADDRESSED);

    await handleSystemEvent(
      'history_bundle',
      { to: TO_ME, requestId: REQUEST, last: true, sealed: honest },
      ctx as any
    );

    expect(lines(error, 'REFUSED an unsealed history_bundle')).toHaveLength(2);
    expect(lines(error, 'answerers are all taken')).toHaveLength(0);
    const added = (ctx.batchAddMessages.mock.calls[0][0] as Array<{ messageId: string }>).map(
      (m) => m.messageId
    );
    expect(added).toEqual(['m1']);
    error.mockRestore();
  });
});
