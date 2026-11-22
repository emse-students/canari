// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

/**
 * THE PAGE'S HALF OF THE MIRROR'S OWNERSHIP (P1 `p1-a-warm-page-erases-the-native-only-outbox-entries`,
 * 2026-11-21). The file's merge rule is Rust's (`outbox_mirror.rs`, its own tests); what is pinned
 * here is what the page hands it and what the page does with the native lines it reads: the WHOLE
 * queue's ids as `held`, the writes in the order asked, a page line never adopted back, and - on a
 * return to the front - the native lines adopted, on screen and flushed, an unsendable one failed
 * with its Retry.
 */

const tauri = vi.hoisted(() => ({
  /** The mirror's lines as `read_outbox_mirror` answers them. */
  mirror: [] as unknown[],
  writes: [] as Array<{ entries: Array<{ id: string }>; held: string[] }>,
  /** Holds the next write until released, to put two in flight. */
  gate: null as Promise<void> | null,
  /**
   * Every write that holds this id fails while it is set, as the command does when it cannot take
   * the lock - keyed on the id so a write still chained from an earlier case is not caught by it.
   */
  failHolding: null as string | null,
  /** What the native fold could not read back, as both commands report it. */
  unreadable: 0,
  /** Reads of the mirror still to fail, as the command does when the file cannot be read. */
  failReads: 0,
  /** Every write fails while set: the fold cannot delete a source, so no page write lands. */
  failWrites: false,
  /**
   * Each write lands as the native merge does (`merge_outbox_mirror`): the page lines replace the
   * mirror's, stamped `owner: "page"`, and a native line whose id the page holds is dropped.
   */
  mergeWrites: false,
}));

const toast = vi.hoisted(() => ({ shown: [] as string[] }));
vi.mock('$lib/stores/toast.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/toast.svelte')>()),
  showToast: (message: string) => void toast.shown.push(message),
}));

vi.mock('$lib/utils/openExternal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/openExternal')>()),
  isTauriRuntime: () => true,
}));
// The one tab: leader, decided - the flush this test watches is the leader's.
vi.mock('$lib/mls-client/tabLeader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/tabLeader')>()),
  getIsTabLeader: () => true,
  getTabLeadership: () => 'leader',
  whenTabLeadershipDecided: () => Promise.resolve('leader'),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'read_outbox_mirror') {
      if (tauri.failReads > 0) {
        tauri.failReads--;
        throw new Error('the mirror could not be read');
      }
      return { entries: tauri.mirror, unreadable: tauri.unreadable };
    }
    if (cmd === 'store_outbox_mirror') {
      const gate = tauri.gate;
      tauri.gate = null;
      if (gate) await gate;
      if (tauri.failWrites) throw new Error('folded but NOT deleted');
      if (tauri.failHolding && (args.held as string[]).includes(tauri.failHolding)) {
        throw new Error('the outbox lock could not be taken');
      }
      tauri.writes.push(args as (typeof tauri.writes)[number]);
      if (tauri.mergeWrites) {
        const held = args.held as string[];
        const native = (tauri.mirror as OutboxMirrorEntry[]).filter(
          (l) => l.owner !== 'page' && !held.includes(l.id)
        );
        const page = (args.entries as OutboxMirrorEntry[]).map((e) => ({ ...e, owner: 'page' }));
        tauri.mirror = [...native, ...page];
      }
      return tauri.unreadable;
    }
    if (cmd === 'read_and_clear_outbox_sent') return [];
    return null;
  }),
}));

import type { OutboxEntry } from '$lib/db';
import type { StoredMessage } from '$lib/db/types';
import type { Conversation } from '$lib/types';
import { toBase64 } from '$lib/utils/hex';
import { parseEnvelope } from '$lib/envelope';
import { announceConversationStored } from '$lib/db/conversationStored';
import { invoke } from '@tauri-apps/api/core';
import { m } from '$lib/paraglide/messages';
import { connectivity } from '$lib/stores/connectivity.svelte';
import {
  MAX_CONSECUTIVE_SERVER_ERRORS,
  buildOutboxProto,
  createOutbox,
  isServerFailureTerminal,
  type OutboxController,
} from './outbox';
import {
  MirrorAdoptionError,
  adoptOrphanedMirrorEntries,
  syncOutboxMirror,
  type OutboxMirrorEntry,
} from './outboxMirror';

function textEntry(id: string, extra: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id,
    conversationId: 'g1',
    sentAt: 1_000,
    kind: 'text',
    text: `hello ${id}`,
    status: 'pending',
    attempts: 0,
    createdAt: 1_000,
    ...extra,
  };
}

/** A mirror line for a text `id`, as the native side writes it (no owner) unless `extra` says. */
function line(id: string, extra: Partial<OutboxMirrorEntry> = {}): OutboxMirrorEntry {
  return {
    id,
    groupId: 'g1',
    proto: toBase64(buildOutboxProto(textEntry(id))!),
    sentAt: 1_000,
    silent: false,
    durable: true,
    ...extra,
  };
}

/** The store surface adoption and one flush touch. */
function makeStorage(seed: OutboxEntry[] = []) {
  const queue = new Map(seed.map((e) => [e.id, structuredClone(e)]));
  const rows = new Map<string, StoredMessage>();
  /** The conversation rows the store holds: a message row naming another is refused (SQLite's FK). */
  const conversationRows = new Set(['g1']);
  return {
    _queue: queue,
    _rows: rows,
    _conversationRows: conversationRows,
    getConversation: vi.fn(async (id: string) => (conversationRows.has(id) ? { id } : null)),
    getPendingGroupExits: vi.fn(async () => []),
    getOutboxQueue: vi.fn(async () => [...queue.values()]),
    getOutboxEntry: vi.fn(async (id: string) => queue.get(id) ?? null),
    saveOutboxEntry: vi.fn(async (e: OutboxEntry) => void queue.set(e.id, structuredClone(e))),
    updateOutboxEntry: vi.fn(async (id: string, patch: Partial<OutboxEntry>) => {
      const e = queue.get(id);
      if (e) queue.set(id, { ...e, ...patch });
    }),
    deleteOutboxEntry: vi.fn(async (id: string) => void queue.delete(id)),
    saveMessagesIfAbsent: vi.fn(async (msgs: StoredMessage[]) => {
      const written = new Set<string>();
      for (const m of msgs) {
        if (!conversationRows.has(m.conversationId)) {
          throw new Error('(code: 787) FOREIGN KEY constraint failed');
        }
        if (rows.has(m.id)) continue;
        rows.set(m.id, m);
        written.add(m.id);
      }
      return written;
    }),
    getMessage: vi.fn(async (id: string) => rows.get(id) ?? null),
    saveMessage: vi.fn(async () => {}),
    updateMessage: vi.fn(async (_c: string, id: string, patch: Partial<StoredMessage>) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, ...patch });
    }),
    mergeMessages: vi.fn(async () => new Set<string>()),
    getReelTakeRecords: vi.fn(async () => []),
  } as any;
}

beforeEach(() => {
  tauri.mirror = [];
  tauri.writes = [];
  tauri.gate = null;
  tauri.failHolding = null;
  tauri.unreadable = 0;
  tauri.failReads = 0;
  tauri.failWrites = false;
  tauri.mergeWrites = false;
  toast.shown = [];
});

describe('syncOutboxMirror - what the page hands the merge', () => {
  it('holds EVERY queued id, the failed text it does not mirror too', async () => {
    const failed = textEntry('failed', { serverErrors: MAX_CONSECUTIVE_SERVER_ERRORS });
    await syncOutboxMirror([textEntry('live'), failed]);
    expect(tauri.writes).toHaveLength(1);
    expect(tauri.writes[0].entries.map((e) => e.id)).toEqual(['live']);
    expect(tauri.writes[0].held).toEqual(['live', 'failed']);
  });

  it('writes one at a time, in the order asked - the older snapshot never lands last', async () => {
    let release!: () => void;
    tauri.gate = new Promise((r) => (release = r));
    const first = syncOutboxMirror([textEntry('a')]);
    const second = syncOutboxMirror([textEntry('a'), textEntry('b')]);
    await Promise.resolve();
    expect(tauri.writes).toHaveLength(0);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(tauri.writes.map((w) => w.held)).toEqual([['a'], ['a', 'b']]);
  });
});

describe('adoptOrphanedMirrorEntries - only the native lines', () => {
  it('adopts a native line and leaves a line the page wrote and no longer queues', async () => {
    tauri.mirror = [line('native'), line('settled', { owner: 'page' })];
    const storage = makeStorage();
    expect(await adoptOrphanedMirrorEntries(storage, 'key', 'me')).toEqual(['native']);
    expect([...storage._queue.keys()]).toEqual(['native']);
  });

  // Review of #3929: a hold taken AFTER the queue write left a window where a flush sent a line a
  // background drain could send too. The hold comes first, and a failed write releases it.
  it('holds an adopted entry BEFORE it is queued, and releases it when the write fails', async () => {
    tauri.mirror = [line('native'), line('broken')];
    const storage = makeStorage();
    const order: string[] = [];
    const save = storage.saveOutboxEntry;
    storage.saveOutboxEntry = vi.fn(async (e: OutboxEntry) => {
      order.push(`save ${e.id}`);
      if (e.id === 'broken') throw new Error('quota');
      return save(e);
    });
    const held = new Set<string>();
    await adoptOrphanedMirrorEntries(storage, 'key', 'me', {
      hold: (id) => void (order.push(`hold ${id}`), held.add(id)),
      release: (id) => void held.delete(id),
    });
    expect(order).toEqual(['hold native', 'save native', 'hold broken', 'save broken']);
    expect([...held]).toEqual(['native']);
  });

  // Review of #3929: a read that failed answered "nothing to adopt", and the start pass took that
  // for a pass that ran.
  it('a mirror it could not read is a failure, never "nothing to adopt"', async () => {
    tauri.failReads = 1;
    await expect(adoptOrphanedMirrorEntries(makeStorage(), 'key', 'me')).rejects.toBeInstanceOf(
      MirrorAdoptionError
    );
  });

  // Mi 9T, 1.7.3-alpha.6: a shade reply in a conversation not stored yet was queued, its row refused
  // by the foreign key - an entry with no row, parked failed on every page life, its text invisible.
  // The entry is now written only beside its row, and a conversation not stored keeps the line native.
  it('never queues an entry without its row: a conversation not stored keeps the line native', async () => {
    tauri.mirror = [line('shade', { groupId: 'g2', unsendable: true })];
    const storage = makeStorage();
    const held = new Set<string>();
    const claims = {
      hold: (id: string) => void held.add(id),
      release: (id: string) => void held.delete(id),
    };
    expect(await adoptOrphanedMirrorEntries(storage, 'key', 'me', claims)).toEqual([]);
    expect(storage._queue.size).toBe(0);
    expect(storage._rows.size).toBe(0);
    expect(held.size).toBe(0);

    // The conversation is stored now: the next pass adopts the line, row and entry together.
    storage._conversationRows.add('g2');
    expect(await adoptOrphanedMirrorEntries(storage, 'key', 'me', claims)).toEqual(['shade']);
    expect(storage._queue.get('shade')?.conversationId).toBe('g2');
    expect(parseEnvelope(storage._rows.get('shade')!.content)).toMatchObject({
      kind: 'text',
      text: 'hello shade',
    });
  });

  it('a row the store refuses queues no entry, and the claim is released', async () => {
    tauri.mirror = [line('shade')];
    const storage = makeStorage();
    storage.saveMessagesIfAbsent.mockRejectedValueOnce(new Error('FOREIGN KEY constraint failed'));
    const held = new Set<string>();
    expect(
      await adoptOrphanedMirrorEntries(storage, 'key', 'me', {
        hold: (id) => void held.add(id),
        release: (id) => void held.delete(id),
      })
    ).toEqual([]);
    expect(storage._queue.has('shade')).toBe(false);
    expect(held.size).toBe(0);
  });

  // A queued entry whose line is still native was adopted by a page life whose claim never landed:
  // the mirror is the durable record of it, and it is held again.
  it('holds a queued entry whose mirror line is still native', async () => {
    tauri.mirror = [line('earlier')];
    const storage = makeStorage([textEntry('earlier')]);
    const held: string[] = [];
    expect(
      await adoptOrphanedMirrorEntries(storage, 'key', 'me', {
        hold: (id) => void held.push(id),
        release: () => {},
      })
    ).toEqual([]);
    expect(held).toEqual(['earlier']);
  });
});

// Review of #3929: a line the native fold could not read back - or a file moved aside it could not
// open - is the member's to know about, not a log line nobody reads (principle 2).
describe('a queued line the native side could not read back', () => {
  it('is told to the member, on the read and on the write', async () => {
    tauri.unreadable = 2;
    await adoptOrphanedMirrorEntries(makeStorage(), 'key', 'me');
    expect(toast.shown).toHaveLength(1);
    await syncOutboxMirror([]);
    expect(toast.shown).toHaveLength(2);
  });

  it('tells nothing when everything was read', async () => {
    tauri.mirror = [line('fine')];
    await adoptOrphanedMirrorEntries(makeStorage(), 'key', 'me');
    await syncOutboxMirror([]);
    expect(toast.shown).toEqual([]);
  });
});

describe('a line already sent by its stored row (an unstamped pre-1.7.3 page line)', () => {
  it('is not adopted, and the next page write holds it so the merge drops it', async () => {
    tauri.mirror = [line('old')];
    const storage = makeStorage();
    storage._rows.set('old', {
      id: 'old',
      conversationId: 'g1',
      senderId: 'me',
      content: 'hello old',
      timestamp: 1_000,
      serverTimestamp: 2_000,
    });
    expect(await adoptOrphanedMirrorEntries(storage, 'key', 'me')).toEqual([]);
    expect(storage._queue.has('old')).toBe(false);
    await syncOutboxMirror([]);
    expect(tauri.writes.at(-1)?.held).toEqual(['old']);
    // Dropped once: the write after it no longer holds it.
    await syncOutboxMirror([]);
    expect(tauri.writes.at(-1)?.held).toEqual([]);
  });
});

describe('OutboxController.adoptNativeEntries - the return to the front', () => {
  const live: OutboxController[] = [];
  afterEach(() => {
    for (const c of live.splice(0)) c.dispose();
  });

  function controllerOver(storage: ReturnType<typeof makeStorage>) {
    const conversations = new SvelteMap<string, Conversation>([
      [
        'g1',
        {
          id: 'g1',
          name: 'g1',
          contactName: 'g1',
          lifecycle: 'active',
          mlsStateHex: null,
          messages: [],
        } as Conversation,
      ],
    ]);
    const sendMessage = vi.fn(async () => ({
      sealed: new Uint8Array(),
      authorProof: new Uint8Array(),
      receivedAt: 1_700_000_000_000,
    }));
    const outbox = createOutbox({
      userId: 'me',
      deviceKey: () => 'key',
      conversations,
      log: () => {},
      requestReAdd: vi.fn().mockResolvedValue(undefined),
      recoverRosterDisagreement: vi.fn().mockResolvedValue(undefined),
      isGroupHealthy: () => true,
      markDeletedRemotely: vi.fn(),
      storage,
      mlsService: {
        getLocalGroups: vi.fn(() => []),
        getGroupMeta: vi.fn(async (id: string) => ({
          groupId: id,
          isGroup: true,
          deletedAt: null,
        })),
        isGroupActive: vi.fn(async () => true),
        getGroupExclusions: vi.fn(async () => new Map()),
        sendMessage,
        waitForMessageQueueIdle: vi.fn(async () => {}),
      },
    } as any);
    live.push(outbox);
    return { outbox, conversations, sendMessage };
  }

  it('adopts the native lines, claims them, shows them, and the flusher sends the sendable one', async () => {
    connectivity.reset();
    tauri.mirror = [line('shade'), line('stuck', { unsendable: true })];
    const storage = makeStorage();
    const { outbox, conversations, sendMessage } = controllerOver(storage);

    expect(await outbox.adoptNativeEntries()).toBe(2);

    // Claimed: the next lines are the page's, and both ids are held.
    expect(tauri.writes.at(-1)?.held.sort()).toEqual(['shade', 'stuck']);
    // On screen: the stuck one FAILED (its Retry), the other pending until sent.
    const shown = new Map(conversations.get('g1')!.messages.map((m) => [m.id, m.status]));
    expect(shown.get('stuck')).toBe('error');
    expect(shown.has('shade')).toBe(true);
    // Flushed: the sendable one goes, the unsendable one waits for its member's Retry.
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(storage._queue.has('shade')).toBe(false);
    expect(storage._queue.has('stuck')).toBe(true);
  });

  it('says an adopted refusal as the refusal, once, and the Retry clears the native verdict', async () => {
    connectivity.reset();
    tauri.mirror = [line('refused', { unsendable: true, unsendableCause: 'refused' })];
    const storage = makeStorage();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { outbox, sendMessage } = controllerOver(storage);
    await outbox.adoptNativeEntries();
    expect(storage._queue.get('refused')?.nativeRefusal).toBe('refused');
    outbox.flush();
    await vi.waitFor(() =>
      expect(errors.mock.calls.some((c) => String(c[0]).includes('(refused)'))).toBe(true)
    );
    // Said ONCE, at the adoption, and never as the 5xx run.
    expect(errors.mock.calls.filter((c) => String(c[0]).includes('refused'))).toHaveLength(1);
    expect(errors.mock.calls.some((c) => String(c[0]).includes('5xx'))).toBe(false);
    errors.mockRestore();

    outbox.retryUpload('refused');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(storage._queue.has('refused')).toBe(false));
    expect(storage.updateOutboxEntry).toHaveBeenCalledWith(
      'refused',
      expect.objectContaining({ serverErrors: 0, nativeRefusal: undefined }),
      'key'
    );
  });

  // Reading `1.7.3-alpha.6`, warm-page row 4: a banner from a conversation this device was removed
  // from cannot be produced on a bench without a dev write the sitting does not own. The line the
  // native drain marked unsendable is adopted FAILED, with its Retry at once, and the page's own
  // later outbox work - another message queued, a flush, the status pass - leaves it where it is.
  it('an unsendable native line is adopted FAILED, stays failed under later outbox work, and Retry sends it', async () => {
    connectivity.reset();
    tauri.mirror = [line('stuck', { unsendable: true })];
    const storage = makeStorage();
    const { outbox, conversations, sendMessage } = controllerOver(storage);
    const statusOf = (id: string) =>
      conversations.get('g1')!.messages.find((m) => m.id === id)?.status;

    expect(await outbox.adoptNativeEntries()).toBe(1);
    expect(statusOf('stuck')).toBe('error');
    expect(isServerFailureTerminal(storage._queue.get('stuck'))).toBe(true);

    // A following page mutation: another message is queued and flushed, the statuses are re-applied.
    await storage.saveOutboxEntry(textEntry('after', { sentAt: 2_000, createdAt: 2_000 }));
    await outbox.flush();
    await outbox.applyPendingStatuses();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(storage._queue.has('after')).toBe(false);
    expect(storage._queue.has('stuck')).toBe(true);
    expect(statusOf('stuck')).toBe('error');

    // Its Retry is available at once, and sends it.
    outbox.retryUpload('stuck');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
  });

  // Review of #3929: a failed claim leaves the line native in the mirror, where a background drain
  // may send it - so the page does not send it either until a mirror write holding it lands. The
  // server's messageId dedup is never what prevents the second send.
  it('does not send an adopted entry whose claim failed, until a later claim lands', async () => {
    connectivity.reset();
    tauri.mirror = [line('shade')];
    tauri.failHolding = 'shade';
    const storage = makeStorage();
    const { outbox, conversations, sendMessage } = controllerOver(storage);

    expect(await outbox.adoptNativeEntries()).toBe(1);
    outbox.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(storage._queue.has('shade')).toBe(true);
    // Never silently "pending" on a claim that cannot land: failed, with its Retry.
    const row = () => conversations.get('g1')!.messages.find((m) => m.id === 'shade');
    expect(row()?.status).toBe('error');

    // The lock is back: the next return to the front adopts nothing new, but claims - and the claim
    // raises the flush.
    tauri.failHolding = null;
    tauri.mirror = [line('shade')];
    expect(await outbox.adoptNativeEntries()).toBe(0);
    expect(tauri.writes.at(-1)?.held).toEqual(['shade']);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  });

  // Review of #3929: the unclaimed entry's Retry is a Retry of the CLAIM - the one thing failing.
  it('Retry on an unclaimed entry claims again, and the claim that lands sends it', async () => {
    connectivity.reset();
    tauri.mirror = [line('shade')];
    tauri.failHolding = 'shade';
    const storage = makeStorage();
    const { outbox, conversations, sendMessage } = controllerOver(storage);
    await outbox.adoptNativeEntries();
    const row = () => conversations.get('g1')!.messages.find((m) => m.id === 'shade');
    expect(row()?.status).toBe('error');

    // Still failing: still failed, nothing sent.
    outbox.retryUpload('shade');
    await new Promise((r) => setTimeout(r, 0));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(row()?.status).toBe('error');

    tauri.failHolding = null;
    outbox.retryUpload('shade');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(tauri.writes.some((w) => w.held.includes('shade'))).toBe(true);
    await vi.waitFor(() => expect(storage._queue.has('shade')).toBe(false));
  });

  // Review of #3929: `unclaimed` is memory, and a reload lost it - the queue then flushed an entry
  // the mirror still named native. The START PASS reads it back from the mirror, before any flush.
  it('a new page life holds a queued entry still native in the mirror before its first flush', async () => {
    connectivity.reset();
    tauri.mirror = [line('earlier')];
    tauri.failHolding = 'earlier';
    const storage = makeStorage([textEntry('earlier')]);
    const { outbox, sendMessage } = controllerOver(storage);

    outbox.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(sendMessage).not.toHaveBeenCalled();

    tauri.failHolding = null;
    outbox.retryUpload('earlier');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  });

  // Review of #3929: a start pass that fails sends nothing, and NO TIMER runs it again - the next
  // real trigger does (here a flush, as an enqueue, a resume or a reconnect raises one).
  it('a start pass that fails holds an adopted entry, and the next trigger runs it again', async () => {
    connectivity.reset();
    // The fold fails: the read and every write with it, as the commands do.
    tauri.failReads = Number.POSITIVE_INFINITY;
    tauri.failWrites = true;
    const storage = makeStorage([textEntry('queued', { adoptedFromMirror: true })]);
    const { outbox, sendMessage } = controllerOver(storage);
    outbox.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(sendMessage).not.toHaveBeenCalled();
    tauri.failReads = 0;
    tauri.failWrites = false;
    outbox.flush();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  });

  // Review of #3929: a source the fold can never delete failed EVERY start pass, and the flush
  // returned before sending anything - every conversation pending, nobody told. Now the page's own
  // entries go, only the adopted ones (still possibly native) are held, failed with their Retry, and
  // the member is told once.
  it('a fold that keeps failing holds only the adopted entries, tells once, and the rest goes', async () => {
    connectivity.reset();
    tauri.failReads = Number.POSITIVE_INFINITY;
    tauri.failWrites = true;
    const storage = makeStorage([
      textEntry('mine'),
      textEntry('shade', { adoptedFromMirror: true }),
    ]);
    for (const id of ['mine', 'shade']) {
      storage._rows.set(id, {
        id,
        conversationId: 'g1',
        senderId: 'me',
        content: `hello ${id}`,
        timestamp: 1_000,
      });
    }
    const { outbox, conversations, sendMessage } = controllerOver(storage);
    await outbox.applyPendingStatuses();
    const errors = vi.spyOn(console, 'error');
    const accused = () =>
      errors.mock.calls.filter((c) => String(c[0]).startsWith('[OUTBOX] start pass failed')).length;

    outbox.flush();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(storage._queue.has('mine')).toBe(false);
    expect(storage._queue.has('shade')).toBe(true);
    const row = () => conversations.get('g1')!.messages.find((msg) => msg.id === 'shade');
    expect(row()?.status).toBe('error');
    expect(toast.shown).toEqual([m.chat_outbox_native_queue_unreachable()]);
    expect(accused()).toBe(1);

    // Every later trigger runs the pass again - still failing, told no more, accused no more (an
    // ERROR per flush would be noise), still nothing extra.
    outbox.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(toast.shown).toHaveLength(1);
    expect(accused()).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    errors.mockRestore();

    // The file heals: the Retry claims it, and it goes - its adopted mark cleared by the claim.
    tauri.failReads = 0;
    tauri.failWrites = false;
    tauri.mirror = [line('shade')];
    outbox.retryUpload('shade');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
  });

  // The member is told the side that failed, chosen from the error's TYPE: an unreadable queue is
  // not "replies from your notifications".
  it('a start pass blocked on the queue says so, not the mirror', async () => {
    tauri.mirror = [line('elsewhere')];
    const storage = makeStorage();
    storage.getOutboxQueue.mockRejectedValue(new Error('the queue could not be read'));
    const { outbox } = controllerOver(storage);
    outbox.flush();
    await vi.waitFor(() => expect(toast.shown).toEqual([m.chat_outbox_queue_unreadable()]));
  });

  // An entry adopted before the mark existed (a page life older than the mark) is still native in the
  // mirror: the pass that reads it there marks it, so a later failing pass holds it too.
  it('a queued entry still native in the mirror is marked as adopted by the start pass', async () => {
    tauri.failWrites = true;
    const storage = makeStorage([textEntry('older')]);
    tauri.mirror = [line('older')];
    const { outbox } = controllerOver(storage);
    await outbox.adoptNativeEntries();
    expect(storage._queue.get('older')?.adoptedFromMirror).toBe(true);
  });

  // The adopted mark goes with the first write that lands: from then the line is the page's, and a
  // later failed start pass never holds it again.
  it('a claim that lands clears the adopted mark', async () => {
    const storage = makeStorage([textEntry('adopted', { adoptedFromMirror: true })]);
    const { outbox } = controllerOver(storage);
    tauri.mirror = [line('adopted')];
    await outbox.adoptNativeEntries();
    await vi.waitFor(() =>
      expect(storage.updateOutboxEntry).toHaveBeenCalledWith(
        'adopted',
        { adoptedFromMirror: undefined },
        'key'
      )
    );
    // Settled - sent, and every write it raised landed - before the next case reads the writes.
    await vi.waitFor(() => expect(storage._queue.has('adopted')).toBe(false));
    await syncOutboxMirror([]);
  });

  it('the start pass writes the mirror once before the first flush sends anything', async () => {
    connectivity.reset();
    const storage = makeStorage([textEntry('queued')]);
    const { outbox, sendMessage } = controllerOver(storage);
    outbox.flush();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(tauri.writes[0]?.held).toEqual(['queued']);
  });

  // Review of #3929: the mirror write waits for the native writers' lock, which a background drain
  // holds through its POSTs - the send typed now must not wait for it.
  it('sends an enqueued message while its mirror write is still waiting for the lock', async () => {
    connectivity.reset();
    const storage = makeStorage();
    const { outbox, sendMessage } = controllerOver(storage);
    // The page life's start pass first (it DOES wait for the lock: what it holds could otherwise be
    // sent twice) - then a drain takes the lock.
    outbox.flush();
    await vi.waitFor(() => expect(tauri.writes).toHaveLength(1));
    let release!: () => void;
    tauri.gate = new Promise((r) => (release = r));

    await outbox.enqueue(textEntry('typed'));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(tauri.writes).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(tauri.writes.length).toBeGreaterThan(1));
  });

  // The entry an older build left alone (no row): rebuilt from its own text, shown failed with its
  // Retry so the member can see and delete it, and accused ONCE - not on every page life.
  it('an entry queued with no row gets its row back from its own text, accused once', async () => {
    connectivity.reset();
    const storage = makeStorage([
      textEntry('orphan', { serverErrors: MAX_CONSECUTIVE_SERVER_ERRORS }),
    ]);
    const { outbox, conversations } = controllerOver(storage);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const accused = () =>
      errors.mock.calls.filter((c) => String(c[0]).includes('was queued with no stored message'))
        .length;

    await outbox.applyPendingStatuses();
    expect(parseEnvelope(storage._rows.get('orphan')!.content)).toMatchObject({
      kind: 'text',
      text: 'hello orphan',
    });
    const row = () => conversations.get('g1')!.messages.find((msg) => msg.id === 'orphan');
    expect(row()?.status).toBe('error');
    expect(accused()).toBe(1);

    // The next page life reads the row: nothing accused again.
    conversations.set('g1', { ...conversations.get('g1')!, messages: [] });
    await outbox.applyPendingStatuses();
    expect(row()?.status).toBe('error');
    expect(accused()).toBe(1);
    errors.mockRestore();
  });

  // Review of #3969 (P1): two passes reading the mirror and the queue before either wrote both
  // adopted the line, and the second re-inserted what a flush had sent and deleted in between.
  it('two adoptions at once and a flush between them send the line once', async () => {
    connectivity.reset();
    tauri.mergeWrites = true;
    const storage = makeStorage();
    const { outbox, sendMessage } = controllerOver(storage);
    // The widest window: a second write of the entry is held until the first send has landed - the
    // moment a pass that read before the first one wrote would put it back.
    let sent!: () => void;
    const firstSent = new Promise<void>((r) => (sent = r));
    sendMessage.mockImplementation(async () => {
      sent();
      return { sealed: new Uint8Array(), authorProof: new Uint8Array(), receivedAt: 1 };
    });
    const save = storage.saveOutboxEntry;
    let saves = 0;
    storage.saveOutboxEntry = vi.fn(async (e: OutboxEntry) => {
      if (++saves > 1) await firstSent;
      return save(e);
    });

    // 1. The page life's start pass, over an empty mirror, settles first: nothing else is chained.
    tauri.mirror = [];
    await outbox.flush();
    tauri.mirror = [line('shade')];

    // 2. Two passes at once. Unchained, both read the line native and the queue empty; the first
    // queues and claims it and its flush sends it, then the second's write - held until that send -
    // queues it again, and its claim's flush sends it a second time.
    await Promise.all([outbox.adoptNativeEntries(), outbox.adoptNativeEntries()]);

    // 3. The controller's own settle, then one more flush: nothing left to send.
    await outbox.awaitSettled('shade');
    await outbox.flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(saves).toBe(1);
    expect(storage._queue.has('shade')).toBe(false);
  });

  // Review of #3969 (S2): a line left native for want of its conversation's row is adopted by the
  // write of that row, not at the next return to the front.
  it('adopts a waiting line the moment its conversation row is written', async () => {
    connectivity.reset();
    tauri.mirror = [line('late', { groupId: 'g2' })];
    const storage = makeStorage();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { outbox, sendMessage } = controllerOver(storage);
    expect(await outbox.adoptNativeEntries()).toBe(0);
    expect(storage._queue.has('late')).toBe(false);

    // A row of another conversation adopts nothing.
    announceConversationStored('g9');
    await new Promise((r) => setTimeout(r, 0));
    expect(storage._queue.has('late')).toBe(false);

    storage._conversationRows.add('g2');
    announceConversationStored('g2');
    // Adopted with its row, claimed, and sent - by the row's write alone.
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(parseEnvelope(storage._rows.get('late')!.content)).toMatchObject({ kind: 'text' });
    // Said once, not once per pass.
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('Orphan late')).length).toBe(1);
    warn.mockRestore();
  });

  // Review of #3969 (N1): a waiting record was cleared only by an adoption, so a line that left the
  // mirror another way (a drain sent it) kept naming its conversation, and every later write of that
  // row ran a full pass. Each pass now records only the lines it found waiting.
  it('a waiting line that left the mirror stops naming its conversation', async () => {
    connectivity.reset();
    tauri.mirror = [line('gone', { groupId: 'g3' })];
    const storage = makeStorage();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { outbox } = controllerOver(storage);
    await outbox.adoptNativeEntries();
    expect(storage._queue.has('gone')).toBe(false);
    const reads = () =>
      vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'read_outbox_mirror').length;

    // A background drain sent it: the line left the mirror. The row is written twice.
    tauri.mirror = [];
    storage._conversationRows.add('g3');
    const before = reads();
    announceConversationStored('g3');
    // That pass, then a pass of our own chained behind it: both settled once this one resolves.
    await outbox.adoptNativeEntries();
    expect(reads()).toBe(before + 2);
    announceConversationStored('g3');
    await outbox.adoptNativeEntries();
    // Only our own pass ran: the second write found nothing waiting for g3.
    expect(reads()).toBe(before + 3);
    expect(storage._queue.size).toBe(0);
    warn.mockRestore();
  });

  // Re-review of #3969: a conversation read that failed dropped the line from the waiting set - its
  // row-write trigger lost, its WARN said again. A failed read proves nothing: it keeps waiting.
  it('a conversation read that fails keeps the line waiting, and says nothing again', async () => {
    connectivity.reset();
    tauri.mirror = [line('flaky', { groupId: 'g4' })];
    const storage = makeStorage();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const said = () => warn.mock.calls.filter((c) => String(c[0]).includes('Orphan flaky')).length;
    const { outbox, sendMessage } = controllerOver(storage);
    await outbox.adoptNativeEntries();
    expect(said()).toBe(1);

    storage.getConversation.mockRejectedValueOnce(new Error('database is locked'));
    await outbox.adoptNativeEntries();
    expect(storage._queue.has('flaky')).toBe(false);

    // Still waiting: the row's write adopts it, and nothing was said a second time.
    storage._conversationRows.add('g4');
    announceConversationStored('g4');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(said()).toBe(1);
    warn.mockRestore();
  });

  it('adopts nothing and writes nothing when the mirror holds only the page lines', async () => {
    tauri.mirror = [line('p1', { owner: 'page' })];
    const storage = makeStorage([textEntry('p1')]);
    const { outbox } = controllerOver(storage);
    expect(await outbox.adoptNativeEntries()).toBe(0);
    expect(tauri.writes).toHaveLength(0);
  });
});
