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
    if (cmd === 'read_outbox_mirror') return tauri.mirror;
    if (cmd === 'store_outbox_mirror') {
      const gate = tauri.gate;
      tauri.gate = null;
      if (gate) await gate;
      tauri.writes.push(args as (typeof tauri.writes)[number]);
      return null;
    }
    if (cmd === 'read_and_clear_outbox_sent') return [];
    return null;
  }),
}));

import type { OutboxEntry } from '$lib/db';
import type { StoredMessage } from '$lib/db/types';
import type { Conversation } from '$lib/types';
import { toBase64 } from '$lib/utils/hex';
import { connectivity } from '$lib/stores/connectivity.svelte';
import {
  MAX_CONSECUTIVE_SERVER_ERRORS,
  buildOutboxProto,
  createOutbox,
  type OutboxController,
} from './outbox';
import {
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
  return {
    _queue: queue,
    _rows: rows,
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
    expect(await adoptOrphanedMirrorEntries(storage, 'key', 'me')).toBe(1);
    expect([...storage._queue.keys()]).toEqual(['native']);
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

  it('adopts nothing and writes nothing when the mirror holds only the page lines', async () => {
    tauri.mirror = [line('p1', { owner: 'page' })];
    const storage = makeStorage([textEntry('p1')]);
    const { outbox } = controllerOver(storage);
    expect(await outbox.adoptNativeEntries()).toBe(0);
    expect(tauri.writes).toHaveLength(0);
  });
});
