/**
 * THE LIVE CHAT SESSION AND THE BROADCASTER'S LOOP, AGAINST FAKES (no network, no timer, no clock).
 *
 * Pinned: the cursors a poll asks with, advanced only once a block is drawn; blocks applied in
 * arrival order although opening is asynchronous; a message that does not open dropped, never
 * drawn; my message drawn at once and replaced (never doubled) whether the answer or a poll brings
 * it first; a retry re-sending the SAME bytes; tombstones; one burst a tick for any number of taps;
 * every send failure classified once; the broadcaster's loop stopping on the live's end only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LIVE_CHAT_KEPT_LINES,
  LiveBroadcasterChatPoller,
  LiveChatSession,
  isLiveOverRefusal,
  liveChatSendFailure,
  LIVE_ARRIVAL_LINES_KEPT,
  LIVE_REACTION_KINDS,
  liveReactionEmoji,
  type LiveChatDeps,
  type LiveChatLine,
} from './liveChat';
import { LiveRefusalError } from './api';
import { LiveChatOpenError } from './liveChatCrypto';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { flushMacrotask } from '../../test/flush';
import type { LiveChatBlock, LiveChatMessageWire, LiveManifest, LiveReactionKind } from './types';

const LIVE = '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';
const KEY = 'ab'.repeat(32);
const ME = 'a'.repeat(64);
const BOB = 'b'.repeat(64);

const refusal = (kind: LiveRefusalError['kind'], status: number, code: string | null = null) =>
  new LiveRefusalError(status, code, kind, kind, null, null, null);

let ids: number;
let lines: readonly LiveChatLine[];
let floats: [LiveReactionKind, number][];
let deps: LiveChatDeps & {
  postMessage: ReturnType<typeof vi.fn>;
  postReactions: ReturnType<typeof vi.fn>;
  hideMessage: ReturnType<typeof vi.fn>;
};

/** A message on the wire; its "seal" is its text behind a prefix the fake open reads back. */
function wire(
  seq: number,
  text: string,
  authorId = BOB,
  clientId = `c-${seq}`
): LiveChatMessageWire {
  return {
    id: `m-${seq}`,
    seq,
    authorId,
    clientId,
    sealed: `S:${text}`,
    createdAt: '2026-10-19T10:00:00.000Z',
  };
}

function block(
  messages: LiveChatBlock['messages'],
  cursor: number,
  extra: Partial<LiveChatBlock> = {}
) {
  return { messages, messagesCursor: cursor, reactions: [], reactionsCursor: 0, ...extra };
}

function session(me: string | null = ME) {
  return sessionFor(() => me);
}

function sessionFor(me: () => string | null) {
  const s = new LiveChatSession({
    liveId: LIVE,
    me,
    onChange: (l) => {
      lines = l;
    },
    onFloat: (kind, n) => floats.push([kind, n]),
    deps,
  });
  s.setKey(KEY);
  return s;
}

const texts = () => lines.map((l) => l.text);

beforeEach(() => {
  ids = 0;
  lines = [];
  floats = [];
  deps = {
    postMessage: vi.fn(async (_live: string, clientId: string, sealed: string) => ({
      ...wire(100, sealed.slice(2), ME, clientId),
    })),
    postReactions: vi.fn(async (_l: string, burstId: string) => ({ burstId, seq: 1 })),
    hideMessage: vi.fn(async (liveId: string, messageId: string) => ({
      liveId,
      messageId,
      hidden: true as const,
    })),
    seal: vi.fn(async (_k, _l, _c, _a, text: string) => `S:${text}`),
    open: vi.fn(async (_k, _l, _c, _a, sealed: string) => {
      if (!sealed.startsWith('S:')) throw new LiveChatOpenError('unauthentic', sealed.length);
      // A slow open for one text - it yields a whole macrotask, which every other open does not -
      // to prove the order does not follow the open's speed. A queue position, never a duration.
      if (sealed === 'S:slow') await flushMacrotask();
      return sealed.slice(2);
    }),
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  };
});

describe('reading the chat', () => {
  it('asks with no cursor first (the newest 50), then with the cursors the last block gave', async () => {
    const s = session();
    expect(s.query()).toEqual({ messagesAfter: undefined, reactionsAfter: undefined });
    await s.receive(block([wire(1, 'one'), wire(2, 'two')], 2, { reactionsCursor: 7 }));
    expect(s.query()).toEqual({ messagesAfter: 2, reactionsAfter: 7 });
    expect(texts()).toEqual(['one', 'two']);
  });

  it('applies blocks in arrival order even when an open is slow', async () => {
    const s = session();
    void s.receive(block([wire(1, 'slow')], 1));
    await s.receive(block([wire(2, 'fast')], 2));
    expect(texts()).toEqual(['slow', 'fast']);
    expect(s.query().messagesAfter).toBe(2);
  });

  it('drops a message that does not open, draws the rest, and still moves the cursor', async () => {
    const s = session();
    await s.receive(
      block([wire(1, 'ok'), { ...wire(2, ''), sealed: 'tampered' }, wire(3, 'ok too')], 3)
    );
    expect(texts()).toEqual(['ok', 'ok too']);
    expect(s.query().messagesAfter).toBe(3);
  });

  it('never draws a message twice when a poll answers it again', async () => {
    const s = session();
    await s.receive(block([wire(1, 'one')], 1));
    await s.receive(block([wire(1, 'one'), wire(2, 'two')], 2));
    expect(texts()).toEqual(['one', 'two']);
  });

  it('removes the line a tombstone names', async () => {
    const s = session();
    await s.receive(block([wire(1, 'one'), wire(2, 'two')], 2));
    await s.receive(block([{ id: 'm-1', seq: 3, hidden: true }], 3));
    expect(texts()).toEqual(['two']);
  });

  it('applies nothing before the key - the cursor does not move past an undrawn message', async () => {
    const s = new LiveChatSession({ liveId: LIVE, me: () => ME, onChange: () => {}, deps });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await s.receive(block([wire(1, 'one')], 1));
    expect(s.query().messagesAfter).toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it(`keeps the newest ${LIVE_CHAT_KEPT_LINES} lines`, async () => {
    const s = session();
    const many = Array.from({ length: LIVE_CHAT_KEPT_LINES + 5 }, (_, i) =>
      wire(i + 1, `t${i + 1}`)
    );
    await s.receive(block(many, many.length));
    expect(lines).toHaveLength(LIVE_CHAT_KEPT_LINES);
    expect(lines[0].text).toBe('t6');
  });

  it("floats everyone else's reactions with their counts, in kind order", async () => {
    const s = session();
    await s.receive(
      block([], 0, {
        reactions: [{ window: 4, counts: { canari: 2, like: 3 } }],
        reactionsCursor: 9,
      })
    );
    expect(floats).toEqual([
      ['like', 3],
      ['canari', 2],
    ]);
  });
});

describe('writing', () => {
  it('draws my message at once, then as the server stored it - once', async () => {
    const s = session();
    const pending = s.send('  hello  ');
    expect(lines.map((l) => [l.text, l.status])).toEqual([['hello', 'pending']]);
    expect(await pending).toBeNull();
    expect(lines.map((l) => [l.id, l.status, l.mine])).toEqual([['m-100', 'sent', true]]);
    // The poll then serves it too: still one line.
    const clientId = lines[0].clientId;
    await s.receive(block([wire(100, 'hello', ME, clientId)], 100));
    expect(lines).toHaveLength(1);
  });

  it('a poll that brings my message before the answer replaces the pending line', async () => {
    let answer!: () => void;
    deps.postMessage.mockImplementation(
      (_l: string, clientId: string) =>
        new Promise((resolve) => {
          answer = () => resolve(wire(5, 'hi', ME, clientId));
        })
    );
    const s = session();
    const sent = s.send('hi');
    await vi.waitFor(() => expect(deps.postMessage).toHaveBeenCalled());
    await s.receive(block([wire(5, 'hi', ME, lines[0].clientId)], 5));
    expect(lines.map((l) => [l.id, l.status])).toEqual([['m-5', 'sent']]);
    answer();
    await sent;
    expect(lines).toHaveLength(1);
  });

  it('refuses an empty or too long message before sealing anything', async () => {
    const s = session();
    s.setLimits({ chatMessageMaxChars: 5, reactionTapsPerWindow: 10 });
    expect(await s.send('   ')).toBe('empty');
    expect(await s.send('123456')).toBe('too-long');
    expect(await s.send('12345')).toBeNull();
    expect(deps.seal).toHaveBeenCalledTimes(1);
  });

  it('cannot write without an account', async () => {
    const s = session(null);
    expect(s.canWrite).toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await s.send('x')).toBe('refused');
    warn.mockRestore();
  });

  it('keeps a failed line with its reason, and a retry sends the SAME sealed bytes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.postMessage.mockRejectedValueOnce(new TransportFailureError('offline'));
    const s = session();
    expect(await s.send('again')).toBe('network');
    expect(lines.map((l) => [l.status, l.failure])).toEqual([['failed', 'network']]);
    const clientId = lines[0].clientId;
    expect(await s.retry(clientId)).toBeNull();
    expect(deps.seal).toHaveBeenCalledTimes(1);
    expect(deps.postMessage.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [clientId, 'S:again'],
      [clientId, 'S:again'],
    ]);
    expect(lines.map((l) => l.status)).toEqual(['sent']);
    warn.mockRestore();
  });

  it('sends the accounts a line mentions beside the sealed text, the same ones on a retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const CARA = 'c'.repeat(64);
    deps.postMessage.mockRejectedValueOnce(new TransportFailureError('offline'));
    const s = session();
    const text = `hi @[${CARA}] and @[${CARA}] again`;
    expect(await s.send(text)).toBe('network');
    expect(await s.retry(lines[0].clientId)).toBeNull();
    expect(deps.postMessage.mock.calls.map((c) => c[3])).toEqual([[CARA], [CARA]]);
    warn.mockRestore();
  });

  it('a line with no mention sends an empty list', async () => {
    const s = session();
    expect(await s.send('plain')).toBeNull();
    expect(deps.postMessage.mock.calls[0][3]).toEqual([]);
  });

  it('discards a failed line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.postMessage.mockRejectedValueOnce(refusal('rate-limited', 429, 'LIVE_MESSAGE_TOO_FAST'));
    const s = session();
    expect(await s.send('x')).toBe('too-fast');
    s.discard(lines[0].clientId);
    expect(lines).toEqual([]);
    warn.mockRestore();
  });

  it.each([
    [refusal('rate-limited', 429, 'LIVE_MESSAGE_TOO_FAST'), 'too-fast'],
    [refusal('removed', 403, 'LIVE_VIEWER_REMOVED'), 'removed'],
    [refusal('ended', 410, 'LIVE_ENDED'), 'ended'],
    [refusal('not-found', 404, 'LIVE_NOT_FOUND'), 'ended'],
    [refusal('refused', 403, 'LIVE_MUTED'), 'muted'],
    [refusal('refused', 403, 'LIVE_CHAT_WITHHELD'), 'withheld'],
    [refusal('refused', 409, 'LIVE_MESSAGE_CONFLICT'), 'refused'],
    [refusal('unavailable', 502), 'network'],
    [new TransportFailureError('offline'), 'network'],
    [new Error('bug'), 'refused'],
  ])('classifies %s as %s', (error, failure) => {
    expect(liveChatSendFailure(error)).toBe(failure);
  });

  it('hides a line on success, and keeps it when the server refused', async () => {
    const s = session();
    await s.receive(block([wire(1, 'one'), wire(2, 'two')], 2));
    expect(await s.hide('m-1')).toBe(true);
    expect(texts()).toEqual(['two']);
    deps.hideMessage.mockRejectedValueOnce(refusal('not-found', 404, 'LIVE_NOT_FOUND'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await s.hide('m-2')).toBe(false);
    expect(texts()).toEqual(['two']);
    warn.mockRestore();
  });
});

describe('reactions', () => {
  it('floats each tap at once and sends ONE summed burst at the next tick', () => {
    const s = session();
    s.tap('like');
    s.tap('like');
    s.tap('canari');
    expect(floats).toEqual([
      ['like', 1],
      ['like', 1],
      ['canari', 1],
    ]);
    expect(deps.postReactions).not.toHaveBeenCalled();
    s.query();
    expect(deps.postReactions).toHaveBeenCalledTimes(1);
    expect(deps.postReactions.mock.calls[0][2]).toEqual({ like: 2, canari: 1 });
    s.query();
    expect(deps.postReactions).toHaveBeenCalledTimes(1);
  });

  it("caps a burst at the server's taps per window; past it a tap still floats", () => {
    const s = session();
    s.setLimits({ chatMessageMaxChars: 300, reactionTapsPerWindow: 2 });
    for (let i = 0; i < 4; i++) s.tap('fire');
    expect(floats).toHaveLength(4);
    s.query();
    expect(deps.postReactions.mock.calls[0][2]).toEqual({ fire: 2 });
  });

  it('drops a refused burst and says so - never retried', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.postReactions.mockRejectedValueOnce(
      refusal('rate-limited', 429, 'LIVE_REACTION_TOO_FAST')
    );
    const s = session();
    s.tap('clap');
    s.query();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    s.query();
    expect(deps.postReactions).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('draws the five kinds: the shared names keep the post emoji, bravo and fire are new', () => {
    expect(liveReactionEmoji('canari')).toBe('🐤');
    expect(liveReactionEmoji('like')).toBe('❤️');
    expect(liveReactionEmoji('clap')).toBe('👏');
    expect(liveReactionEmoji('fire')).toBe('🔥');
    expect(LIVE_REACTION_KINDS).toEqual(['like', 'laugh', 'clap', 'fire', 'canari']);
  });
});

describe("the broadcaster's chat loop", () => {
  let timers: { fn: () => void; ms: number }[];
  let manifests: (LiveManifest | Error)[];
  const fetchManifest = vi.fn();

  const manifest = (chat: LiveChatBlock, viewers: number | null = 0): LiveManifest => ({
    liveId: LIVE,
    nextIndex: 0,
    lastSegmentAt: null,
    serverNow: '2026-10-19T10:00:00.000Z',
    segments: [],
    viewers,
    chat,
  });

  beforeEach(() => {
    timers = [];
    manifests = [];
    fetchManifest.mockReset();
    fetchManifest.mockImplementation(async () => {
      const next = manifests.shift();
      if (next instanceof Error) throw next;
      return next ?? manifest(block([], 0));
    });
  });

  async function runTimer() {
    const t = timers.shift();
    expect(t, 'a timer is pending').toBeDefined();
    t!.fn();
    await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0));
    return t!.ms;
  }

  it('polls once a tick with the cursors, and stops for good on the end', async () => {
    const s = session();
    const ended = vi.fn();
    const poller = new LiveBroadcasterChatPoller(
      LIVE,
      s,
      {
        fetchManifest,
        schedule: (fn, ms) => {
          timers.push({ fn, ms });
          return () => {};
        },
      },
      ended
    );
    manifests.push(manifest(block([wire(1, 'one')], 1)));
    poller.start();
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(fetchManifest).toHaveBeenLastCalledWith(LIVE, undefined, {
      messagesAfter: undefined,
      reactionsAfter: undefined,
    });
    expect(texts()).toEqual(['one']);
    expect(await runTimer()).toBe(1_000);
    expect(fetchManifest).toHaveBeenLastCalledWith(LIVE, undefined, {
      messagesAfter: 1,
      reactionsAfter: 0,
    });
    // A transport failure retries after the backoff; the end stops it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    manifests.push(new TransportFailureError('offline'));
    expect(await runTimer()).toBe(1_000);
    manifests.push(refusal('ended', 410, 'LIVE_ENDED'));
    const t = timers.shift()!;
    t.fn();
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    expect(ended.mock.calls[0][0]).toBeInstanceOf(LiveRefusalError);
    expect((ended.mock.calls[0][0] as LiveRefusalError).status).toBe(410);
    expect(timers).toHaveLength(0);
    warn.mockRestore();
    poller.stop();
  });

  it("hands the broadcaster each poll's viewer count, a number or nothing, from the same request", async () => {
    const counts: (number | null)[] = [];
    const poller = new LiveBroadcasterChatPoller(
      LIVE,
      session(),
      {
        fetchManifest,
        schedule: (fn, ms) => {
          timers.push({ fn, ms });
          return () => {};
        },
      },
      undefined,
      (count) => counts.push(count)
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    manifests.push(
      manifest(block([], 0), 3),
      manifest(block([], 0), null),
      manifest(block([], 0), 5),
      new TransportFailureError('offline')
    );
    poller.start();
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    await runTimer();
    await runTimer();
    // A failed tick drops the number rather than leaving the last one on screen.
    await runTimer();
    expect(counts).toEqual([3, null, 5, null]);
    // One request a tick: the count costs no fetch of its own.
    expect(fetchManifest).toHaveBeenCalledTimes(4);
    warn.mockRestore();
    poller.stop();
  });
});

describe('the review of #2136', () => {
  it('(a) a malformed row is dropped alone: the rest is drawn and the chat goes on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = session();
    const broken = { ...wire(2, 'x'), authorId: null } as unknown as LiveChatMessageWire;
    await s.receive(block([wire(1, 'one'), broken, wire(3, 'three')], 3));
    expect(texts()).toEqual(['one', 'three']);
    expect(s.query().messagesAfter).toBe(3);
    await s.receive(block([wire(4, 'four')], 4));
    expect(texts()).toEqual(['one', 'three', 'four']);
    warn.mockRestore();
  });

  it('(b) my own echo is OPENED: one that does not open turns my line unreadable, never "sent"', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = session();
    expect(await s.send('hello')).toBeNull();
    const clientId = lines[0].clientId;
    expect(lines[0].status).toBe('sent');
    await s.receive(block([{ ...wire(100, '', ME, clientId), sealed: 'tampered' }], 100));
    expect(lines.map((l) => [l.status, l.failure])).toEqual([['failed', 'unreadable']]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unreadable to everyone else'));
    error.mockRestore();
  });

  it('(b) an echo that opens is checked once, and the line stays one "sent" line', async () => {
    const s = session();
    await s.send('hello');
    const clientId = lines[0].clientId;
    await s.receive(block([wire(100, 'hello', ME, clientId)], 100));
    await s.receive(block([wire(100, 'hello', ME, clientId)], 100));
    expect(deps.open).toHaveBeenCalledTimes(1);
    expect(lines.map((l) => [l.id, l.status])).toEqual([['m-100', 'sent']]);
  });

  it('(b) a message stored under another author than it was sealed for is unreadable at once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    deps.postMessage.mockImplementationOnce(async (_l: string, clientId: string) =>
      wire(7, 'x', BOB, clientId)
    );
    const s = session();
    expect(await s.send('x')).toBe('unreadable');
    expect(lines.map((l) => l.failure)).toEqual(['unreadable']);
    error.mockRestore();
  });

  it('(c) two overlapping polls: the second asks from the first block cursors, so nothing floats twice', async () => {
    const s = session();
    const first = block([wire(1, 'slow')], 1, {
      reactions: [{ window: 2, counts: { like: 4 } }],
      reactionsCursor: 3,
    });
    const applied = s.receive(first);
    // The next tick fires before the slow open is done.
    expect(s.query()).toEqual({ messagesAfter: 1, reactionsAfter: 3 });
    // So the server answers only what came after: nothing new.
    await s.receive(block([], 1, { reactionsCursor: 3 }));
    await applied;
    expect(floats).toEqual([['like', 4]]);
    expect(texts()).toEqual(['slow']);
  });

  it('(d) an account that loads after the screen opened can write then', async () => {
    let me: string | null = null;
    const s = sessionFor(() => me);
    expect(s.canWrite).toBe(false);
    me = ME;
    expect(s.canWrite).toBe(true);
    expect(await s.send('hi')).toBeNull();
    expect(deps.seal).toHaveBeenCalledWith(KEY, LIVE, expect.any(String), ME, 'hi');
  });

  it('(e) a replay of a message under a NEW server id is not drawn twice', async () => {
    const s = session();
    await s.receive(block([wire(1, 'one', BOB, 'c-x')], 1));
    await s.receive(block([{ ...wire(9, 'one', BOB, 'c-x') }], 9));
    expect(texts()).toEqual(['one']);
  });
});

describe('a write answered "the live is over" (WP-L6)', () => {
  function overSession() {
    const over = vi.fn();
    const s = new LiveChatSession({
      liveId: LIVE,
      me: () => ME,
      onChange: (l) => {
        lines = l;
      },
      onLiveOver: over,
      deps,
    });
    s.setKey(KEY);
    return { s, over };
  }

  it('the verdicts are ended, not-found and removed - nothing else', () => {
    expect(isLiveOverRefusal(refusal('ended', 410, 'LIVE_ENDED'))).toBe(true);
    expect(isLiveOverRefusal(refusal('not-found', 404))).toBe(true);
    expect(isLiveOverRefusal(refusal('removed', 403))).toBe(true);
    expect(isLiveOverRefusal(refusal('rate-limited', 429))).toBe(false);
    expect(isLiveOverRefusal(refusal('refused', 403, 'LIVE_MUTED'))).toBe(false);
    expect(isLiveOverRefusal(new TransportFailureError('offline'))).toBe(false);
  });

  it('a send, a hide and a burst each hand the verdict to the screen; a 429 does not', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { s, over } = overSession();
    const gone = refusal('ended', 410, 'LIVE_ENDED');
    deps.postMessage.mockRejectedValueOnce(gone);
    expect(await s.send('hi')).toBe('ended');
    expect(over).toHaveBeenLastCalledWith(gone);
    deps.hideMessage.mockRejectedValueOnce(gone);
    expect(await s.hide('m-1')).toBe(false);
    expect(over).toHaveBeenCalledTimes(2);
    deps.postReactions.mockRejectedValueOnce(gone);
    s.tap('like');
    s.query();
    await vi.waitFor(() => expect(over).toHaveBeenCalledTimes(3));
    deps.postMessage.mockRejectedValueOnce(refusal('rate-limited', 429));
    expect(await s.send('again')).toBe('too-fast');
    expect(over).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('after the screen stopped the session, a late verdict is not reported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { s, over } = overSession();
    let reject!: (e: unknown) => void;
    deps.hideMessage.mockImplementationOnce(() => new Promise((_, r) => (reject = r)));
    const hiding = s.hide('m-1');
    s.stop();
    reject(refusal('ended', 410, 'LIVE_ENDED'));
    expect(await hiding).toBe(false);
    expect(over).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the chat withheld from a named reader (owner, 2026-11-04)', () => {
  function watched() {
    const told: boolean[] = [];
    const s = new LiveChatSession({
      liveId: LIVE,
      me: () => ME,
      onChange: (l) => {
        lines = l;
      },
      onFloat: (kind, n) => floats.push([kind, n]),
      onWithheld: (w) => told.push(w),
      deps,
    });
    return { s, told };
  }

  it('the open says it: no composer from the first frame, told once', () => {
    const { s, told } = watched();
    s.onKey(KEY, { chatWithheld: true });
    expect(s.withheld).toBe(true);
    expect(s.canWrite).toBe(false);
    expect(told).toEqual([true]);
    // An open that says nothing (an older server) is not withheld.
    const other = watched();
    other.s.onKey(KEY);
    expect(other.s.withheld).toBe(false);
    expect(other.s.canWrite).toBe(true);
    expect(other.told).toEqual([]);
  });

  it('a withheld block draws no line, keeps no message cursor, and still floats the reactions', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { s, told } = watched();
    s.onKey(KEY);
    await s.receive(block([wire(1, 'avant')], 1));
    expect(texts()).toEqual(['avant']);
    await s.receive(
      block([wire(2, 'never drawn')], 9, {
        withheld: true,
        reactions: [{ window: 0, counts: { fire: 2 } }],
        reactionsCursor: 4,
      })
    );
    expect(lines).toEqual([]);
    expect(floats).toEqual([['fire', 2]]);
    expect(s.query()).toEqual({ messagesAfter: undefined, reactionsAfter: 4 });
    expect(told).toEqual([true]);
    info.mockRestore();
  });

  it('switched back ON, the next poll is a joiner: the backlog is drawn and writing comes back', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { s, told } = watched();
    s.onKey(KEY, { chatWithheld: true });
    await s.receive(block([], 5, { withheld: true }));
    expect(s.query().messagesAfter).toBeUndefined();
    await s.receive(block([wire(4, 'backlog'), wire(5, 'newest')], 5));
    expect(texts()).toEqual(['backlog', 'newest']);
    expect(s.query().messagesAfter).toBe(5);
    expect(s.canWrite).toBe(true);
    expect(told).toEqual([true, false]);
    info.mockRestore();
  });

  it('a send refused LIVE_CHAT_WITHHELD (the switch went off between two polls) withholds at once, with no failed line', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    deps.postMessage.mockRejectedValueOnce(refusal('refused', 403, 'LIVE_CHAT_WITHHELD'));
    const { s, told } = watched();
    s.onKey(KEY);
    expect(await s.send('bonjour')).toBe('withheld');
    expect(lines).toEqual([]);
    expect(s.withheld).toBe(true);
    expect(told).toEqual([true]);
    info.mockRestore();
  });

  it('a send while already withheld is refused here: no pending line, no request, nothing kept for the way back', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { s } = watched();
    s.onKey(KEY, { chatWithheld: true });
    expect(await s.send('bonjour')).toBe('withheld');
    expect(deps.postMessage).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
    // Served again: the backlog alone is drawn, never the refused line.
    await s.receive(block([wire(4, 'backlog')], 4));
    expect(texts()).toEqual(['backlog']);
    info.mockRestore();
  });

  it('a block still opening its rows when a withheld block arrives draws none of them, and its reactions still float', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    // The first row's open waits on a gate the test opens, so the withheld block lands MID-block:
    // an ordering, never a duration.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let opening!: () => void;
    const opened = new Promise<void>((r) => (opening = r));
    deps.open = vi.fn(async (_k, _l, _c, _a, sealed: string) => {
      if (sealed === 'S:gated') {
        opening();
        await gate;
      }
      return sealed.slice(2);
    });
    const { s } = watched();
    s.onKey(KEY);
    const first = s.receive(
      block([wire(1, 'gated'), wire(2, 'after')], 2, {
        reactions: [{ window: 0, counts: { clap: 1 } }],
        reactionsCursor: 1,
      })
    );
    await opened;
    const second = s.receive(block([], 9, { withheld: true, reactionsCursor: 1 }));
    release();
    await first;
    await second;
    expect(deps.open).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([]);
    expect(s.withheld).toBe(true);
    expect(floats).toEqual([['clap', 1]]);
    info.mockRestore();
  });
});

describe('the arrival lines (owner, 2026-11-07)', () => {
  const JOINER = 'c'.repeat(64);
  const OTHER = 'd'.repeat(64);

  it('draws one line per named arrival, then the folded crowd, and passes the cursor back', async () => {
    const s = session();
    await s.receive(block([wire(1, 'salut')], 1));
    await s.receive(
      block([], 1, {
        arrivals: [
          { userId: JOINER.toUpperCase(), seq: 1 },
          { userId: OTHER, seq: 2 },
        ],
        arrivalsMore: 4,
        arrivalsCursor: 9,
      })
    );
    expect(lines.map((l) => [l.kind, l.more])).toEqual([
      [undefined, undefined],
      ['arrival', undefined],
      ['arrival', undefined],
      ['arrivals-more', 4],
    ]);
    expect(lines[1].authorId).toBe(JOINER);
    expect(s.query().arrivalsAfter).toBe(9);
    // A later message lands UNDER the arrival lines, whatever its own number.
    await s.receive(block([wire(2, 'apres')], 2));
    expect(lines.at(-1)?.text).toBe('apres');
  });

  it("sorts a block's arrivals under ITS OWN messages, even when a newer block arrived before it was drawn", async () => {
    const s = session();
    // Two polls land back to back: the cursors move at arrival, the rows are drawn in order after.
    const first = s.receive(
      block([wire(1, 'un')], 1, { arrivals: [{ userId: JOINER, seq: 1 }], arrivalsCursor: 1 })
    );
    const second = s.receive(block([wire(2, 'deux'), wire(3, 'trois')], 3));
    await Promise.all([first, second]);
    expect(lines.map((l) => l.kind ?? l.text)).toEqual(['un', 'arrival', 'deux', 'trois']);
  });

  it('draws a line once per server sequence, and drops a malformed row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = session();
    const arrivals = [
      { userId: JOINER, seq: 1 },
      { userId: JOINER, seq: 1 },
      { userId: 7 as unknown as string, seq: 2 },
    ];
    await s.receive(block([], 0, { arrivals, arrivalsMore: 0, arrivalsCursor: 2 }));
    expect(lines.filter((l) => l.kind === 'arrival')).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('keeps its cursor when the server sent none, and has none while the chat is withheld', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const s = session();
    await s.receive(block([], 0, { arrivals: [], arrivalsMore: 0, arrivalsCursor: 5 }));
    await s.receive(block([], 0));
    expect(s.query().arrivalsAfter).toBe(5);
    await s.receive(block([], 3, { withheld: true, arrivals: [{ userId: JOINER, seq: 6 }] }));
    expect(s.query().arrivalsAfter).toBeUndefined();
    expect(lines.filter((l) => l.kind)).toEqual([]);
    info.mockRestore();
  });

  it('keeps only the newest arrival lines, so a crowd never buries the conversation', async () => {
    const s = session();
    const arrivals = Array.from({ length: LIVE_ARRIVAL_LINES_KEPT + 5 }, (_, i) => ({
      userId: JOINER,
      seq: i + 1,
    }));
    await s.receive(block([], 0, { arrivals, arrivalsMore: 0, arrivalsCursor: arrivals.length }));
    const kept = lines.filter((l) => l.kind === 'arrival');
    expect(kept).toHaveLength(LIVE_ARRIVAL_LINES_KEPT);
    expect(kept[0].clientId).toBe('arrival:6');
  });
});
