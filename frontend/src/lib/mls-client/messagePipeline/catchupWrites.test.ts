/**
 * The store writes of a catch-up are batched, and the result is the per-frame one (2026-11-28): one
 * merge per conversation for the reactions, one save per conversation for the read marks, the same
 * rows at the end, in the same order, and no ack ahead of the disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';
import { ReactionsByConversation } from '$lib/utils/chat/reactionsByConversation';
import type { MessageReaction } from '$lib/types';
import { createCatchupWrites } from './catchupWrites';
import { applyReactionFrame, type ReactionFrame } from './reactionFrame';

type Row = { id: string; senderId: string; reactions?: MessageReaction[]; [k: string]: unknown };

/** A store that applies `merge` to the rows it holds, like the compare-and-set does uncontended. */
function fakeStore(initial: Record<string, Row[]>) {
  const rows = new Map<string, Map<string, Row>>();
  for (const [convo, list] of Object.entries(initial)) {
    rows.set(convo, new Map(list.map((r) => [r.id, structuredClone(r)])));
  }
  const mergeCalls: Array<{ convo: string; ids: string[] }> = [];
  const storage = {
    getMessagesByIds: vi.fn(async (convo: string, ids: string[]) => ({
      rows: new Map(
        ids.flatMap((id) => {
          const row = rows.get(convo)?.get(id);
          return row ? [[id, structuredClone(row)] as const] : [];
        })
      ),
      unreadable: new Set<string>(),
    })),
    mergeMessages: vi.fn(async (convo: string, ids: string[], merge: (r: Row) => Row | null) => {
      mergeCalls.push({ convo, ids: [...ids] });
      const written = new Set<string>();
      for (const id of ids) {
        const current = rows.get(convo)?.get(id);
        if (!current) continue;
        const next = merge(structuredClone(current));
        if (next) {
          rows.get(convo)!.set(id, next);
          written.add(id);
        }
      }
      return written;
    }),
  };
  const snapshot = () =>
    Object.fromEntries([...rows].map(([c, m]) => [c, Object.fromEntries(m)])) as Record<
      string,
      Record<string, Row>
    >;
  return { storage, mergeCalls, snapshot };
}

const INITIAL = {
  'convo-a': [
    { id: 'm1', senderId: 'author', isEdited: true },
    { id: 'm2', senderId: 'author' },
  ],
  'convo-b': [{ id: 'm3', senderId: 'author' }],
};

/** A catch-up's reaction frames: several reactors, an add then a removal, a replay, two conversations. */
const FRAMES: Array<[string, string, ReactionFrame]> = [
  ['convo-a', 'p1', { messageId: 'm1', emoji: '+1', at: 10 }],
  ['convo-a', 'p2', { messageId: 'm1', emoji: '+1', at: 11 }],
  ['convo-a', 'p1', { messageId: 'm2', emoji: 'x', at: 12 }],
  ['convo-b', 'p1', { messageId: 'm3', emoji: '+1', at: 13 }],
  ['convo-a', 'p1', { messageId: 'm1', emoji: '+1', at: 14, removed: true }],
  ['convo-a', 'p2', { messageId: 'm1', emoji: '+1', at: 11 }], // a replay: changes nothing
  ['convo-b', 'p2', { messageId: 'm3', emoji: '+1', at: 15 }],
];

const WINDOW = { bufferUi: true, showOverlay: false } as const;

function conversationMap() {
  const conversations = new SvelteMap<string, never>();
  for (const key of ['convo-a', 'convo-b']) {
    conversations.set(key, { id: key, messages: [] } as never);
  }
  return conversations;
}

/** One session: a store, a ledger writing into it, and the handler's deps. */
function session(batched: boolean) {
  const store = fakeStore(INITIAL);
  const conversations = conversationMap();
  const saveConversation = vi.fn(async () => undefined);
  const writes = createCatchupWrites({
    storage: store.storage as never,
    deviceKey: () => 'device-key',
    conversations,
    saveConversation,
    log: vi.fn(),
  });
  const messageReactions = new ReactionsByConversation();
  const deps = {
    storage: store.storage,
    deviceKey: () => 'device-key',
    conversations,
    messageReactions,
    log: vi.fn(),
    ...(batched ? { catchupWrites: writes } : {}),
  } as never;
  const run = async (frames = FRAMES) => {
    for (const [i, [convo, sender, frame]] of frames.entries()) {
      await applyReactionFrame(deps, convo, sender, frame, undefined, 1_000 + i, `frame-${i}`);
    }
  };
  return { store, writes, run, messageReactions, saveConversation };
}

function ledger(over: Partial<Parameters<typeof createCatchupWrites>[0]> = {}) {
  const conversations = conversationMap();
  const saveConversation = vi.fn(async (_key: string) => undefined);
  const writes = createCatchupWrites({
    storage: null,
    deviceKey: () => 'k',
    conversations,
    saveConversation,
    log: vi.fn(),
    ...over,
  });
  return { writes, saveConversation, conversations };
}

describe('the reactions of a catch-up', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('end on the same rows as one write per frame, in ONE merge per conversation', async () => {
    const perFrame = session(false);
    await perFrame.run();

    const batched = session(true);
    batched.writes.onBulkIngestStart(WINDOW);
    await batched.run();

    // Nothing is on disk before the close, and every frame's ack is withheld meanwhile.
    expect(batched.store.mergeCalls).toHaveLength(0);
    expect([...batched.writes.framesLeftUnstored()].sort()).toEqual(
      FRAMES.map((_, i) => `frame-${i}`)
        .filter((id) => id !== 'frame-5')
        .sort()
    );
    await batched.writes.onBulkIngestEnd(WINDOW);

    // The replay (frame 5) folds to nothing and writes nothing; every other frame wrote once.
    expect(perFrame.store.mergeCalls).toHaveLength(FRAMES.length - 1);
    expect(batched.store.mergeCalls.map((c) => c.convo)).toEqual(['convo-a', 'convo-b']);
    expect(batched.store.snapshot()).toEqual(perFrame.store.snapshot());
    expect(batched.store.snapshot()['convo-a'].m1.isEdited).toBe(true);
    for (const [convo, id] of [
      ['convo-a', 'm1'],
      ['convo-a', 'm2'],
      ['convo-b', 'm3'],
    ]) {
      expect(batched.messageReactions.get(convo, id)).toEqual(
        perFrame.messageReactions.get(convo, id)
      );
    }
    expect(batched.writes.framesLeftUnstored().size).toBe(0);
  });

  it('replayed after the flush, change nothing (idempotence)', async () => {
    const s = session(true);
    s.writes.onBulkIngestStart(WINDOW);
    await s.run();
    await s.writes.onBulkIngestEnd(WINDOW);
    const once = s.store.snapshot();
    // The window is closed: the same frames are written per frame now, and the rows do not move.
    await s.run();
    expect(s.store.snapshot()).toEqual(once);
  });

  it('is KEPT as a pending mutation per frame when the one merge throws', async () => {
    const park = vi.fn(async () => undefined);
    const { writes } = ledger({
      storage: {
        mergeMessages: vi.fn().mockRejectedValue(new Error('QuotaExceededError')),
      } as never,
    });
    writes.onBulkIngestStart(WINDOW);
    for (const id of ['m1', 'm2']) {
      writes.deferReaction({
        convoKey: 'convo-a',
        messageId: id,
        fold: () => null,
        frameId: id,
        park,
      });
    }
    await writes.onBulkIngestEnd(WINDOW);
    expect(park).toHaveBeenCalledTimes(2);
    expect(writes.framesLeftUnstored().size).toBe(0);
  });
});

describe('the read marks of a catch-up', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('save a conversation ONCE at the close, and withhold each frame until then', async () => {
    const { writes, saveConversation } = ledger();
    writes.onBulkIngestStart(WINDOW);
    expect(writes.deferring()).toBe(true);
    for (const [i, key] of ['convo-a', 'convo-a', 'convo-b', 'convo-a'].entries()) {
      writes.deferConversationSave(key, `f${i}`);
    }
    expect(saveConversation).not.toHaveBeenCalled();
    expect([...writes.framesLeftUnstored()].sort()).toEqual(['f0', 'f1', 'f2', 'f3']);
    await writes.onBulkIngestEnd(WINDOW);
    expect(saveConversation.mock.calls.map((c) => c[0])).toEqual(['convo-a', 'convo-b']);
    expect(writes.framesLeftUnstored().size).toBe(0);
    expect(writes.deferring()).toBe(false);
  });

  it('keep a failed save, withhold its frames, and write it again at the next flush', async () => {
    const saveConversation = vi
      .fn<(key: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('disk'))
      .mockResolvedValue(undefined);
    const { writes } = ledger({ saveConversation });
    writes.onBulkIngestStart(WINDOW);
    writes.deferConversationSave('convo-a', 'f0');
    await writes.onBulkIngestEnd(WINDOW);
    expect([...writes.framesLeftUnstored()]).toEqual(['f0']);
    writes.onBulkIngestStart(WINDOW);
    await writes.onBulkIngestEnd(WINDOW);
    expect(saveConversation).toHaveBeenCalledTimes(2);
    expect(writes.framesLeftUnstored().size).toBe(0);
  });

  it('drop the save of a conversation that left the map, and say so', async () => {
    const log = vi.fn();
    const { writes, saveConversation, conversations } = ledger({ log });
    writes.onBulkIngestStart(WINDOW);
    writes.deferConversationSave('convo-a', 'f0');
    conversations.delete('convo-a');
    await writes.onBulkIngestEnd(WINDOW);
    expect(saveConversation).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('left the map'));
  });
});

describe('the window and the checkpoint hold', () => {
  it('defer only while a UI-buffering window is open', async () => {
    const { writes } = ledger();
    expect(writes.deferring()).toBe(false);
    writes.onBulkIngestStart({ bufferUi: false, showOverlay: true });
    expect(writes.deferring()).toBe(false);
    writes.onBulkIngestStart(WINDOW);
    writes.onBulkIngestStart(WINDOW);
    await writes.onBulkIngestEnd(WINDOW);
    expect(writes.deferring()).toBe(true); // windows overlap: the other still holds
    await writes.onBulkIngestEnd(WINDOW);
    expect(writes.deferring()).toBe(false);
  });

  it('a hold writes what is held first, and nothing is held until it is released', async () => {
    const { writes, saveConversation } = ledger();
    writes.onBulkIngestStart(WINDOW);
    writes.deferConversationSave('convo-a', 'f0');
    const release = await writes.holdRowsForCheckpoint();
    expect(saveConversation).toHaveBeenCalledTimes(1);
    expect(writes.framesLeftUnstored().size).toBe(0);
    expect(writes.deferring()).toBe(false);
    release();
    release();
    expect(writes.deferring()).toBe(true);
  });
});
