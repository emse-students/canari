import {
  MAX_ANSWERERS_PER_ASK,
  MAX_OPEN_ASKS_PER_GROUP,
  openHistoryAskCount,
  boundAddressedMessages,
  answerSecretOf,
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
import { parseHistoryAnswerKey } from '$lib/crypto/historySeal';
import { toBase64 } from '$lib/utils/hex';

/**
 * Step A, rule 5 (docs/wiki/protocols/history-answer-addressing.md): an addressed history answer is
 * accepted only against an ask this device made, and only for what that ask asked.
 */
const GROUP = 'g1';
const ASKED_AT = 1_700_000_000_000;
/** The device an answer came from (`sender:senderDeviceId`). */
const ANSWERER = 'bob:bob-phone';

const at = (id: string, timestamp: number) => ({ id, timestamp });
/** A secret an ask keeps beside its `answerKey` - every ask carries one since option B. */
const askSecret = () => crypto.getRandomValues(new Uint8Array(32)).map((b) => b | 1);

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
    noteHistoryAsk(GROUP, 'req-a', { kind: 'digest', since: 0, askedAt: ASKED_AT }, askSecret());

    expect(takeAddressedAsk(GROUP, 'req-a', 'bob:p1', false)).not.toBeNull();
    expect(takeAddressedAsk(GROUP, 'req-a', 'carol:p2', false)).not.toBeNull();
    // A third device is refused while the ask is open...
    expect(takeAddressedAsk(GROUP, 'req-a', 'dave:p3', false)).toBeNull();
    expect(takeAddressedAsk(GROUP, 'req-a', 'bob:p1', true)).not.toBeNull();
    expect(takeAddressedAsk(GROUP, 'req-a', 'carol:p2', true)).not.toBeNull();
    // ...and once both answerers are done the ask is gone for everybody.
    expect(takeAddressedAsk(GROUP, 'req-a', 'dave:p3', false)).toBeNull();
    noteHistoryAsk(GROUP, 'req-b', { kind: 'digest', since: 0, askedAt: ASKED_AT }, askSecret());
    expect(openHistoryAskCount(GROUP)).toBe(1);
  });

  it('a second answerer is accepted after the first one closed the ask, the first is not', () => {
    noteHistoryAsk(GROUP, 'req-a', { kind: 'digest', since: 0, askedAt: ASKED_AT }, askSecret());

    expect(takeAddressedAsk(GROUP, 'req-a', ANSWERER, true)?.ask.kind).toBe('digest');
    expect(takeAddressedAsk(GROUP, 'req-a', 'carol:carol-laptop', false)?.ask.kind).toBe('digest');
    expect(takeAddressedAsk(GROUP, 'req-a', 'carol:carol-laptop', true)?.ask.kind).toBe('digest');
    expect(takeAddressedAsk(GROUP, 'req-a', ANSWERER, false)).toBeNull();
    expect(takeAddressedAsk(GROUP, 'req-a', 'carol:carol-laptop', false)).toBeNull();
  });

  it('an ask is taken by its answer, and consumed only by the chunk marked last', () => {
    noteHistoryAsk(GROUP, 'req-a', { kind: 'digest', since: 0, askedAt: ASKED_AT }, askSecret());

    expect(takeAddressedAsk(GROUP, 'req-a', ANSWERER, false)?.ask.kind).toBe('digest');
    expect(takeAddressedAsk(GROUP, 'req-a', ANSWERER, true)?.ask.kind).toBe('digest');
    expect(takeAddressedAsk(GROUP, 'req-a', ANSWERER, true)).toBeNull();
  });

  it('an ask belongs to its conversation', () => {
    noteHistoryAsk(GROUP, 'req-a', { kind: 'digest', since: 0, askedAt: ASKED_AT }, askSecret());

    expect(takeAddressedAsk('other-group', 'req-a', ANSWERER, true)).toBeNull();
  });

  it("the push is taken from a device of the user the Welcome came from, never another member's", () => {
    noteJoinSolicited(GROUP, 'Bob', ASKED_AT);
    expect(takeAddressedAsk(GROUP, undefined, 'carol:carol-phone', true)).toBeNull();
    expect(takeAddressedAsk(GROUP, undefined, ANSWERER, true)?.ask.kind).toBe('join');
  });

  it('the push is solicited by an admission, and by nothing else', () => {
    expect(takeAddressedAsk(GROUP, undefined, ANSWERER, true)).toBeNull();
    noteJoinSolicited(GROUP, 'bob', ASKED_AT);
    expect(takeAddressedAsk(GROUP, undefined, ANSWERER, true)?.ask.kind).toBe('join');
  });

  it(`keeps at most ${MAX_OPEN_ASKS_PER_GROUP} asks per conversation - the oldest goes first, no clock`, () => {
    for (let i = 0; i <= MAX_OPEN_ASKS_PER_GROUP; i++) {
      noteHistoryAsk(
        GROUP,
        `req-${i}`,
        { kind: 'digest', since: 0, askedAt: ASKED_AT },
        askSecret()
      );
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
    const { kept, outOfBound } = boundAddressedMessages(
      { kind: 'join', askedAt: ASKED_AT, inviter: 'bob' },
      [
        at('old', 1),
        at('edge', ASKED_AT + UNDATED_SKEW_MARGIN_MS),
        at('later', ASKED_AT + UNDATED_SKEW_MARGIN_MS + 1),
      ]
    );

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
      ask: {
        kind: 'range',
        since: 100,
        before: 2000,
      },
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
    expect(takeAddressedAsk(GROUP, requestId, ANSWERER, true)?.ask.kind).toBe('digest');
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
      ask: {
        kind: 'pull',
        ids: ['a', 'b'],
      },
    });
  });
});

/**
 * Option B (docs/wiki/protocols/history-answer-addressing.md, 'Sealing the answer to the asker'):
 * every ask carries the public half of a pair minted for it, and keeps the secret beside the open
 * ask - the one that opens its answer.
 */
describe('every ask carries its own answer key, and keeps the secret that opens its answer', () => {
  beforeEach(() => forgetHistoryAsks());

  function asks(mlsService: ReturnType<typeof createMlsServiceStub>) {
    return vi.mocked(mlsService.sendMessage).mock.calls.map(([, bytes]) => {
      const decoded = decodeAppMessage(bytes as Uint8Array);
      return JSON.parse(decoded?.system?.data || '{}') as { requestId: string; answerKey?: string };
    });
  }

  /** The fake engine's public key is its secret reversed - the pairing the real one proves by HPKE. */
  function pairs(secret: Uint8Array | null | undefined, answerKey: string | undefined): boolean {
    return !!secret && !!answerKey && toBase64(Uint8Array.from(secret).reverse()) === answerKey;
  }

  it('a range request, a digest and each pull frame carry a distinct key paired with the kept secret', async () => {
    const mlsService = createMlsServiceStub();
    const storage = {
      getMessages: vi.fn().mockResolvedValue([]),
      getConversation: vi.fn().mockResolvedValue(null),
    } as unknown as IStorage;
    await sendHistoryRangeRequest(
      GROUP,
      { from: 'me:d', before: 2000, limit: 50, since: 100 },
      { mlsService, log: vi.fn() }
    );
    await sendHistoryDigest(GROUP, 'me:d', {
      mlsService,
      log: vi.fn(),
      storage,
      deviceKeyB64: 'k',
    });
    await sendHistoryPull(
      GROUP,
      { from: 'me:d', to: 'peer:d', ids: ['a'], since: 0 },
      { mlsService, log: vi.fn() }
    );

    const sent = asks(mlsService);
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((a) => a.answerKey)).size).toBe(3);
    for (const { requestId, answerKey } of sent) {
      expect(parseHistoryAnswerKey(answerKey)).toBe(answerKey);
      expect(pairs(answerSecretOf(GROUP, requestId), answerKey)).toBe(true);
      expect(takeAddressedAsk(GROUP, requestId, ANSWERER, true)?.keyed).toBe(true);
    }
  });

  it('an engine that cannot mint a key sends no ask at all - never one without a key', async () => {
    const engine = {
      newAnswerKeyPair: vi.fn().mockRejectedValue('randomness'),
      seal: vi.fn(),
      open: vi.fn(),
    };
    const mlsService = createMlsServiceStub({ historySealEngine: vi.fn(() => engine) });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const asked = await sendHistoryRangeRequest(
      GROUP,
      { from: 'me:d', before: 2000, limit: 50, since: 100 },
      { mlsService, log: vi.fn() }
    );

    expect(asked).toBe(false);
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(openHistoryAskCount(GROUP)).toBe(0);
    expect(error.mock.calls.join(' ')).toContain('Could not mint the answer key');
    error.mockRestore();
  });

  it('the join push is an ask with no key', () => {
    noteJoinSolicited(GROUP, 'bob', ASKED_AT);
    expect(takeAddressedAsk(GROUP, undefined, ANSWERER, true)?.keyed).toBe(false);
  });
});

/**
 * The secret an ask keeps is OVERWRITTEN the moment the ask lets it go (review of #3775): JS frees
 * nothing on demand, so a secret dropped from the map would otherwise linger until collected.
 */
describe('a kept answer secret is wiped when its ask lets it go', () => {
  beforeEach(() => forgetHistoryAsks());
  const DIGEST = { kind: 'digest' as const, since: 0, askedAt: ASKED_AT };
  const zeroed = (secret: Uint8Array) => secret.every((b) => b === 0);
  const secret = () => crypto.getRandomValues(new Uint8Array(32)).map((b) => b | 1);

  it('when the ask is closed by its last answerer', () => {
    const kept = secret();
    noteHistoryAsk(GROUP, 'req-a', DIGEST, kept);
    takeAddressedAsk(GROUP, 'req-a', 'bob:p1', true);
    expect(zeroed(kept)).toBe(false);
    takeAddressedAsk(GROUP, 'req-a', 'carol:p2', true);
    expect(zeroed(kept)).toBe(true);
  });

  it('when the same request id is noted again', () => {
    const first = secret();
    noteHistoryAsk(GROUP, 'req-a', DIGEST, first);
    noteHistoryAsk(GROUP, 'req-a', DIGEST, secret());
    expect(zeroed(first)).toBe(true);
  });

  it('when the ask is evicted as the oldest', () => {
    const oldest = secret();
    noteHistoryAsk(GROUP, 'req-0', DIGEST, oldest);
    for (let i = 1; i <= MAX_OPEN_ASKS_PER_GROUP; i++)
      noteHistoryAsk(GROUP, `req-${i}`, DIGEST, secret());
    expect(zeroed(oldest)).toBe(true);
  });

  it('when every ask is forgotten', () => {
    const kept = secret();
    noteHistoryAsk(GROUP, 'req-a', DIGEST, kept);
    forgetHistoryAsks();
    expect(zeroed(kept)).toBe(true);
  });

  it('hands out a COPY, which closing the ask does not wipe from under an open in flight', () => {
    const kept = secret();
    noteHistoryAsk(GROUP, 'req-a', DIGEST, kept);
    const copy = answerSecretOf(GROUP, 'req-a');
    forgetHistoryAsks();
    expect(copy && !zeroed(copy)).toBe(true);
  });
});
