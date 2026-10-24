import {
  MAX_ANSWERERS_PER_ASK,
  MAX_OPEN_ASKS_PER_GROUP,
  openHistoryAskCount,
  boundAddressedMessages,
  forgetHistoryAsks,
  noteHistoryAsk,
  noteJoinSolicited,
  parseHistoryRequestId,
  takeAddressedAsk,
} from './historyAddressing';
import { UNDATED_SKEW_MARGIN_MS } from './historyEntitlement';
import { sendHistoryDigest, sendHistoryPull, sendHistoryRangeRequest } from './groupActions';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { decodeAppMessage } from '$lib/proto/codec';
import type { IStorage } from '$lib/db';

/**
 * Step A, rule 5 (docs/wiki/protocols/history-answer-addressing.md): an addressed history answer is
 * accepted only against an ask this device made, and only for what that ask asked.
 */
const GROUP = 'g1';
const ASKED_AT = 1_700_000_000_000;
/** The device an answer came from (`sender:senderDeviceId`). */
const ANSWERER = 'bob:bob-phone';

const at = (id: string, timestamp: number) => ({ id, timestamp });

describe('historyAddressing - the open asks', () => {
  beforeEach(() => forgetHistoryAsks());

  /**
   * Review of #2270: the rendezvous may hand one ask to a second responder (a re-election over a
   * stored probe), so an ask is consumed PER ANSWERER. A second device's answer is accepted - it is
   * held to the same bound - and the same device after its `last` is refused.
   */
  /**
   * Re-review of #2270: per-answerer closing alone let an ask stay open to any number of answerers.
   * The rendezvous elects ONE, and a re-election can add ONE more - so an ask takes at most
   * MAX_ANSWERERS_PER_ASK, and is gone once they all sent `last`.
   */
  it(`takes at most ${MAX_ANSWERERS_PER_ASK} answerers per ask, and closes once they are done`, () => {
    noteHistoryAsk(GROUP, 'req-a', { kind: 'digest', since: 0, askedAt: ASKED_AT });

    expect(takeAddressedAsk(GROUP, 'req-a', 'bob:p1', false)).not.toBeNull();
    expect(takeAddressedAsk(GROUP, 'req-a', 'carol:p2', false)).not.toBeNull();
    // A third device is refused while the ask is open...
    expect(takeAddressedAsk(GROUP, 'req-a', 'dave:p3', false)).toBeNull();
    expect(takeAddressedAsk(GROUP, 'req-a', 'bob:p1', true)).not.toBeNull();
    expect(takeAddressedAsk(GROUP, 'req-a', 'carol:p2', true)).not.toBeNull();
    // ...and once both answerers are done the ask is gone for everybody.
    expect(takeAddressedAsk(GROUP, 'req-a', 'dave:p3', false)).toBeNull();
    noteHistoryAsk(GROUP, 'req-b', { kind: 'digest', since: 0, askedAt: ASKED_AT });
    expect(openHistoryAskCount(GROUP)).toBe(1);
  });

  it('a second answerer is accepted after the first one closed the ask, the first is not', () => {
    noteHistoryAsk(GROUP, 'req-a', { kind: 'digest', since: 0, askedAt: ASKED_AT });

    expect(takeAddressedAsk(GROUP, 'req-a', ANSWERER, true)?.kind).toBe('digest');
    expect(takeAddressedAsk(GROUP, 'req-a', 'carol:carol-laptop', false)?.kind).toBe('digest');
    expect(takeAddressedAsk(GROUP, 'req-a', 'carol:carol-laptop', true)?.kind).toBe('digest');
    expect(takeAddressedAsk(GROUP, 'req-a', ANSWERER, false)).toBeNull();
    expect(takeAddressedAsk(GROUP, 'req-a', 'carol:carol-laptop', false)).toBeNull();
  });

  it('an ask is taken by its answer, and consumed only by the chunk marked last', () => {
    noteHistoryAsk(GROUP, 'req-a', { kind: 'digest', since: 0, askedAt: ASKED_AT });

    expect(takeAddressedAsk(GROUP, 'req-a', ANSWERER, false)?.kind).toBe('digest');
    expect(takeAddressedAsk(GROUP, 'req-a', ANSWERER, true)?.kind).toBe('digest');
    expect(takeAddressedAsk(GROUP, 'req-a', ANSWERER, true)).toBeNull();
  });

  it('an ask belongs to its conversation', () => {
    noteHistoryAsk(GROUP, 'req-a', { kind: 'digest', since: 0, askedAt: ASKED_AT });

    expect(takeAddressedAsk('other-group', 'req-a', ANSWERER, true)).toBeNull();
  });

  it('the push is solicited by an admission, and by nothing else', () => {
    expect(takeAddressedAsk(GROUP, undefined, ANSWERER, true)).toBeNull();
    noteJoinSolicited(GROUP, ASKED_AT);
    expect(takeAddressedAsk(GROUP, undefined, ANSWERER, true)?.kind).toBe('join');
  });

  it(`keeps at most ${MAX_OPEN_ASKS_PER_GROUP} asks per conversation - the oldest goes first, no clock`, () => {
    for (let i = 0; i <= MAX_OPEN_ASKS_PER_GROUP; i++) {
      noteHistoryAsk(GROUP, `req-${i}`, { kind: 'digest', since: 0, askedAt: ASKED_AT });
    }

    expect(takeAddressedAsk(GROUP, 'req-0', ANSWERER, false)).toBeNull();
    expect(takeAddressedAsk(GROUP, 'req-1', ANSWERER, false)).not.toBeNull();
    expect(
      takeAddressedAsk(GROUP, `req-${MAX_OPEN_ASKS_PER_GROUP}`, ANSWERER, false)
    ).not.toBeNull();
  });

  it('a request id is letters, digits and hyphens - anything else is no id', () => {
    expect(parseHistoryRequestId(crypto.randomUUID())).toBeDefined();
    expect(parseHistoryRequestId('short')).toBeUndefined();
    expect(parseHistoryRequestId('has spaces in it')).toBeUndefined();
    expect(parseHistoryRequestId(42)).toBeUndefined();
  });
});

describe('historyAddressing - what an answer may carry', () => {
  it('nothing sent after the question, beyond the skew margin', () => {
    const { kept, outOfBound } = boundAddressedMessages({ kind: 'join', askedAt: ASKED_AT }, [
      at('old', 1),
      at('edge', ASKED_AT + UNDATED_SKEW_MARGIN_MS),
      at('later', ASKED_AT + UNDATED_SKEW_MARGIN_MS + 1),
    ]);

    expect(kept.map((m) => m.id)).toEqual(['old', 'edge']);
    expect(outOfBound).toBe(1);
  });

  it('a range answer stays inside [since, before)', () => {
    const { kept } = boundAddressedMessages(
      { kind: 'range', since: 100, before: 200, askedAt: ASKED_AT },
      [at('below', 99), at('first', 100), at('last', 199), at('above', 200)]
    );

    expect(kept.map((m) => m.id)).toEqual(['first', 'last']);
  });

  it('a pull answer carries only the ids it named', () => {
    const { kept } = boundAddressedMessages(
      { kind: 'pull', since: 0, ids: ['a'], prefixes: [], askedAt: ASKED_AT },
      [at('a', 10), at('b', 10)]
    );

    expect(kept.map((m) => m.id)).toEqual(['a']);
  });

  it('a digest answer stays above the window the digest stated', () => {
    const { kept } = boundAddressedMessages({ kind: 'digest', since: 100, askedAt: ASKED_AT }, [
      at('below', 50),
      at('inside', 150),
    ]);

    expect(kept.map((m) => m.id)).toEqual(['inside']);
  });
});

describe('every ask carries a fresh request id, recorded before it leaves', () => {
  beforeEach(() => forgetHistoryAsks());

  function payloads(mlsService: ReturnType<typeof createMlsServiceStub>) {
    return vi.mocked(mlsService.sendMessage).mock.calls.map(([, bytes]) => {
      const decoded = decodeAppMessage(bytes as Uint8Array);
      return JSON.parse(decoded?.system?.data || '{}') as { requestId?: string };
    });
  }

  it('a range request', async () => {
    const mlsService = createMlsServiceStub();

    await sendHistoryRangeRequest(
      GROUP,
      { from: 'me:d', before: 2000, limit: 50, since: 100 },
      { mlsService, log: vi.fn() }
    );

    const [{ requestId }] = payloads(mlsService);
    expect(takeAddressedAsk(GROUP, requestId, ANSWERER, true)).toMatchObject({
      kind: 'range',
      since: 100,
      before: 2000,
    });
  });

  it('a digest', async () => {
    const mlsService = createMlsServiceStub();
    const storage = {
      getMessages: vi.fn().mockResolvedValue([]),
      getConversation: vi.fn().mockResolvedValue(null),
    } as unknown as IStorage;

    await sendHistoryDigest(GROUP, 'me:d', {
      mlsService,
      log: vi.fn(),
      storage,
      deviceKeyB64: 'k',
    });

    const [{ requestId }] = payloads(mlsService);
    expect(takeAddressedAsk(GROUP, requestId, ANSWERER, true)?.kind).toBe('digest');
  });

  it('a pull - one ask per frame, each naming its own ids', async () => {
    const mlsService = createMlsServiceStub();

    await sendHistoryPull(
      GROUP,
      { from: 'me:d', to: 'peer:d', ids: ['a', 'b'], since: 0 },
      { mlsService, log: vi.fn() }
    );

    const [{ requestId }] = payloads(mlsService);
    expect(takeAddressedAsk(GROUP, requestId, ANSWERER, true)).toMatchObject({
      kind: 'pull',
      ids: ['a', 'b'],
    });
  });
});
