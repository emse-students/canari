/**
 * WHAT A RENAME STILL OWES, SETTLED BY THE CONNECTION SWEEP (`settleNameSync`).
 *
 * Two halves. The SERVER'S COPY of a name the members hold is written compare-and-set, on the
 * server's name read again right before the write: only while the row holds that name and the server
 * still holds the name the rename was made over - a server naming anything else was written by a
 * later rename, and an owed copy put an older name back over it (#3785 re-review P2-a). The PENDING
 * FRAME - a send that got no answer, its fate unknown - is re-sent as the same frame while the row
 * still shows what it was made over; a frame it stops re-sending is kept `unconfirmed`, never
 * forgotten. Neither half runs before this link has drained the group: a row read before the device
 * has read what arrived while it was out cannot say nothing happened since (re-review 2, P2-2). The
 * recovery path neither settles nor relabels a row that owes something.
 */
import type { Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import { applyNameStatement, type NameStatementOutcome, type PendingRename } from './groupName';
import { restoredConversationRow, toConversationMeta } from './conversations';
import { answerOutrankedStatement } from './nameStatementAnswer';
import { SqliteStorage } from '$lib/db/sqlite';
import type { RenameResendOutcome } from './groupActions';
import { BUNDLE_SERVER_TIME_SKEW_MS } from './messageTime';
import { resetServerClockForTests, serverTimeSeen } from './serverClock';
import {
  ensureConversationForServerGroup,
  RENAME_RESEND_MARGIN_MS,
  newSweepClock,
  type NameSyncSettler,
  type ServerGroupRow,
} from './serverGroupConversation';

const GROUP_ID = 'e4c1f0aa-0000-4000-8000-0000000000b1';
const T = Date.UTC(2026, 10, 17, 9, 0, 0);

function row(over: Partial<Conversation> = {}): Conversation {
  return {
    id: GROUP_ID,
    contactName: GROUP_ID,
    name: 'X',
    messages: [],
    lifecycle: 'active',
    mlsStateHex: null,
    conversationType: 'group',
    imageMediaId: null,
    ...over,
  } as Conversation;
}

const listed = (name: string): ServerGroupRow => ({ groupId: GROUP_ID, name, isGroup: true });

const DELIVERED: RenameResendOutcome = { sent: { receivedAt: T + 60_000, sentAt: T } };

function settler(over: Partial<NameSyncSettler> = {}): NameSyncSettler {
  return {
    resend: vi.fn().mockResolvedValue(DELIVERED),
    state: vi.fn().mockResolvedValue({ sent: { receivedAt: T + 60_000 } }),
    answer: vi.fn().mockResolvedValue({ sent: { receivedAt: T + 60_000 } }),
    clock: newSweepClock(),
    ...over,
  };
}

async function sweep(
  held: Conversation,
  serverName: string,
  opts: {
    nameSync?: NameSyncSettler | null;
    renameGroup?: ReturnType<typeof vi.fn>;
    /** The server's name read again before the write; the listed one when absent. */
    freshName?: string;
    /** Whether this link's pull has drained the group. */
    drained?: boolean;
    /** The server's clock its answer states (`GroupMeta.serverNow`); `null` states none. */
    serverNow?: number | null;
    /** What the group row read answers: a row (default), no answer, no group, a deleted one. */
    status?: 'row' | 'error' | 'absent' | 'deleted';
  } = {}
) {
  const conversations = new Map<string, Conversation>([[GROUP_ID, held]]);
  const renameGroup = opts.renameGroup ?? vi.fn().mockResolvedValue(undefined);
  const serverNow = opts.serverNow === undefined ? T + 60_000 : opts.serverNow;
  const meta = {
    groupId: GROUP_ID,
    name: opts.freshName ?? serverName,
    isGroup: true,
    deletedAt: null as string | null,
    ...(serverNow === null ? {} : { serverNow }),
  };
  const getGroupMeta = vi.fn().mockResolvedValue(meta);
  const status = opts.status ?? 'row';
  const getGroupServerStatus = vi
    .fn()
    .mockResolvedValue(
      status === 'row'
        ? meta
        : status === 'deleted'
          ? { ...meta, deletedAt: '2026-11-17T09:00:00.000Z' }
          : status
    );
  const log = vi.fn();
  const nameSync = opts.nameSync === null ? undefined : (opts.nameSync ?? settler());
  await ensureConversationForServerGroup(listed(serverName), {
    mlsService: {
      renameGroup,
      getGroupMeta,
      getGroupServerStatus,
      isGroupDrained: () => opts.drained ?? true,
    } as unknown as IMlsService,
    userId: 'u1',
    conversations,
    saveConversation: vi.fn(async () => {}),
    owedExits: new Set<string>(),
    log,
    ...(nameSync ? { nameSync } : {}),
  });
  return { row: conversations.get(GROUP_ID)!, renameGroup, log, nameSync };
}

const said = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map((c) => String(c[0])).join('\n');

describe('the owed server copy is written compare-and-set', () => {
  const owing = (over: Partial<Conversation> = {}) =>
    row({ name: 'X', nameAt: T, nameSync: { serverCopy: { name: 'X', from: 'Old' } }, ...over });

  it('written while the server still holds the name the rename was made over', async () => {
    const { row: after, renameGroup } = await sweep(owing(), 'Old');
    expect(renameGroup).toHaveBeenCalledWith(GROUP_ID, 'X');
    expect(after.name).toBe('X');
    expect(after.nameSync).toBeUndefined();
  });

  it('P2-a: a server naming something else was written by a LATER rename - dropped, never overwritten', async () => {
    // A renamed to X, its write failed; B renamed to Y and its write landed; A's sweep runs before
    // A has read B's frame. Writing X now would put an older name over a newer one.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { row: after, renameGroup } = await sweep(owing(), 'Y');
    expect(renameGroup).not.toHaveBeenCalled();
    expect(after.nameSync).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DROPPED, not written'));
    warn.mockRestore();
  });

  it("the compare reads the server's name AGAIN for this group, not the list the sweep began with", async () => {
    // The list said "Old"; a member's rename landed while the sweep worked through earlier groups.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { row: after, renameGroup } = await sweep(owing(), 'Old', { freshName: 'Y' });
    expect(renameGroup).not.toHaveBeenCalled();
    expect(after.nameSync).toBeUndefined();
    warn.mockRestore();
  });

  it('kept owed when the write fails again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { row: after } = await sweep(owing(), 'Old', {
      renameGroup: vi.fn().mockRejectedValue(new Error('503')),
    });
    expect(after.nameSync).toEqual({ serverCopy: { name: 'X', from: 'Old' } });
  });

  it('cleared without a write when the server already holds it', async () => {
    const { row: after, renameGroup } = await sweep(owing(), 'X');
    expect(renameGroup).not.toHaveBeenCalled();
    expect(after.nameSync).toBeUndefined();
  });

  it('an UNDATED rename (no server time in its answer) is not relabelled back, and its copy is written', async () => {
    const { row: after, renameGroup } = await sweep(owing({ nameAt: undefined }), 'Old');
    expect(after.name).toBe('X');
    expect(renameGroup).toHaveBeenCalledWith(GROUP_ID, 'X');
  });

  it('an undated owed name whose write fails again is still not relabelled', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { row: after } = await sweep(owing({ nameAt: undefined }), 'Old', {
      renameGroup: vi.fn().mockRejectedValue(new Error('503')),
    });
    expect(after.name).toBe('X');
    expect(after.nameSync?.serverCopy).toEqual({ name: 'X', from: 'Old' });
  });

  it('P2-2 (ABA): not drained, nothing is written - the name may have come back to "Old" since', async () => {
    // B renamed to Y and C back to Old: the server reads "Old" again, and only the frames this link
    // has not read yet say the row's X is no longer the members' name.
    const { row: after, renameGroup, log } = await sweep(owing(), 'Old', { drained: false });
    expect(renameGroup).not.toHaveBeenCalled();
    expect(after.nameSync).toEqual({ serverCopy: { name: 'X', from: 'Old' } });
    expect(said(log)).toContain('left to the next sweep');
  });

  it('P2-2 (ABA): drained, the row moved back to "Old" with the members - dropped, never written', async () => {
    const { row: after, renameGroup } = await sweep(owing({ name: 'Old', nameAt: T + 9 }), 'Old');
    expect(renameGroup).not.toHaveBeenCalled();
    expect(after.name).toBe('Old');
    expect(after.nameSync).toBeUndefined();
  });

  it('the recovery path neither settles nor relabels a row that owes something', async () => {
    const { row: after, renameGroup } = await sweep(owing({ nameAt: undefined }), 'Old', {
      nameSync: null,
    });
    expect(renameGroup).not.toHaveBeenCalled();
    expect(after.name).toBe('X');
    expect(after.nameSync).toEqual({ serverCopy: { name: 'X', from: 'Old' } });
  });
});

describe('the pending frame (a send with no answer) is re-sent as the same frame', () => {
  const PENDING: PendingRename = {
    name: 'X',
    messageId: 'msg-1',
    sentAt: T,
    over: { name: 'Old', at: T - 1_000 },
  };
  const pendingRow = (over: Partial<Conversation> = {}) =>
    row({ name: 'Old', nameAt: T - 1_000, nameSync: { pending: PENDING }, ...over });

  // #3888 review, B1: a member's one-time restatement of the base - the rollout itself - read as a
  // later name cancelled this device's unanswered rename without a word.
  it('a foreign STATEMENT of the base never supersedes the pending rename: it is re-sent, and outranks it', async () => {
    const undatedBase = { ...PENDING, over: { name: 'Old' }, serverSeenAt: T - 5_000 };
    // A member's restatement of "Old", stamped AFTER this device last heard the server - so it does
    // not date the base, it dates the row.
    const stated = applyNameStatement(
      row({ name: 'Old', nameSync: { pending: undatedBase } }),
      'Old',
      T + 30_000,
      T + 30_000
    );
    if (!('row' in stated)) throw new Error('statement not applied');
    expect(stated.row).toMatchObject({ nameAt: T + 30_000, nameFromStatement: true });
    const { row: after, nameSync } = await sweep(stated.row, 'Old');
    expect(nameSync!.resend).toHaveBeenCalledWith(undatedBase, GROUP_ID, GROUP_ID);
    // Delivered at T + 60 000: the rename outranks the statement whatever the dates.
    expect(after).toMatchObject({ name: 'X', nameAt: T + 60_000 });
    expect(after.nameFromStatement).toBeUndefined();
    expect(after.nameSync?.unconfirmed).toBeUndefined();
  });

  it('two statements of the base, the later one held: still re-sent', async () => {
    const { nameSync, row: after } = await sweep(
      pendingRow({ nameAt: T + 40_000, nameFromStatement: true }),
      'Old'
    );
    expect(nameSync!.resend).toHaveBeenCalledWith(PENDING, GROUP_ID, GROUP_ID);
    expect(after.nameSync?.unconfirmed).toBeUndefined();
  });

  it('re-sent while the row holds what it was made over; delivered, dated, then the copy written', async () => {
    const { row: after, renameGroup, nameSync } = await sweep(pendingRow(), 'Old');
    expect(nameSync!.resend).toHaveBeenCalledWith(PENDING, GROUP_ID, GROUP_ID);
    expect(after).toMatchObject({ name: 'X', nameAt: T + 60_000 });
    expect(renameGroup).toHaveBeenCalledWith(GROUP_ID, 'X');
    expect(after.nameSync).toBeUndefined();
  });

  // ROUND 6, P2: the members renamed Old -> B -> Old after this device's unanswered Old -> X. After
  // the drain the row shows "Old" again - the name the rename was made over - but under the date of
  // the members' LATER statement. Re-sending X then beat that statement for every member.
  it('Old -> B -> Old: the same name under a later date is a later statement - never re-sent over', async () => {
    const { row: after, nameSync } = await sweep(pendingRow({ nameAt: T + 5 }), 'Old');
    expect(nameSync!.resend).not.toHaveBeenCalled();
    expect(after).toMatchObject({ name: 'Old', nameAt: T + 5 });
    expect(after.nameSync).toEqual({ unconfirmed: PENDING });
  });

  it('a base that was undated is re-sent over once a join push dated that very name', async () => {
    const undatedBase = { ...PENDING, over: { name: 'Old' } };
    const s = settler();
    // The join push restated "Old" at T - 500 (`withRestatedGroupName`), and dated `over` with it.
    const { nameSync } = await sweep(
      row({
        name: 'Old',
        nameAt: T - 500,
        nameSync: { pending: { ...undatedBase, over: { name: 'Old', at: T - 500 } } },
      }),
      'Old',
      { nameSync: s }
    );
    expect(nameSync!.resend).toHaveBeenCalled();
  });

  it('P2-2: the pull failed - nothing is re-sent, the frame stays pending, and the line says why', async () => {
    const { row: after, nameSync, log } = await sweep(pendingRow(), 'Old', { drained: false });
    expect(nameSync!.resend).not.toHaveBeenCalled();
    expect(after.nameSync).toEqual({ pending: PENDING });
    expect(said(log)).toContain('left to the next sweep');
  });

  it("P2-2: the pull succeeded and brought a member's later rename B - superseded, never re-sent over it", async () => {
    const { row: after, nameSync } = await sweep(pendingRow({ name: 'B', nameAt: T + 5 }), 'B');
    expect(nameSync!.resend).not.toHaveBeenCalled();
    expect(after.name).toBe('B');
    // Kept, never forgotten: its first copy may have landed after B (`ownRenameFromRelay`).
    expect(after.nameSync).toEqual({ unconfirmed: PENDING });
  });

  it('no answer again: still pending, nothing else written', async () => {
    const s = settler({ resend: vi.fn().mockResolvedValue({ kept: 'unanswered' }) });
    const { row: after, renameGroup } = await sweep(pendingRow(), 'Old', { nameSync: s });
    expect(after.name).toBe('Old');
    expect(after.nameSync).toEqual({ pending: PENDING });
    expect(renameGroup).not.toHaveBeenCalled();
  });

  it('P2-1: a re-send that was not made proves nothing about the first copy - still pending', async () => {
    const s = settler({ resend: vi.fn().mockResolvedValue({ kept: 'not-sent' }) });
    const { row: after } = await sweep(pendingRow(), 'Old', { nameSync: s });
    expect(after.nameSync).toEqual({ pending: PENDING });
  });

  it('a re-send ANSWERED with a refusal that ends it is kept unconfirmed, not forgotten', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = settler({ resend: vi.fn().mockResolvedValue({ refused: 'group-deleted' }) });
    const { row: after } = await sweep(pendingRow(), 'Old', { nameSync: s });
    expect(after.name).toBe('Old');
    expect(after.nameSync).toEqual({ unconfirmed: PENDING });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('REFUSED (group-deleted)'));
    error.mockRestore();
  });

  it('its own frame came back: not re-sent, only the server copy written', async () => {
    const {
      row: after,
      nameSync,
      renameGroup,
    } = await sweep(pendingRow({ name: 'X', nameAt: T + 30 }), 'Old');
    expect(nameSync!.resend).not.toHaveBeenCalled();
    expect(renameGroup).toHaveBeenCalledWith(GROUP_ID, 'X');
    expect(after.nameSync).toBeUndefined();
  });

  // ROUND 7, F2: the bound the receivers apply is measured on the SERVER's clock, and a re-send past
  // it is refused by every member while each still draws its notice. So it is read in the sweep,
  // from the server's answer - never this device's clock, never an older server time held here.
  // ROUND 8, item 1: less a margin, since the frame is stamped after that read by the send's latency.
  it("the server's clock inside the margin before the bound: not re-sent, kept unconfirmed", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = settler();
    const { row: after } = await sweep(pendingRow(), 'Old', {
      nameSync: s,
      serverNow: T + BUNDLE_SERVER_TIME_SKEW_MS - RENAME_RESEND_MARGIN_MS + 1,
    });
    expect(s.resend).not.toHaveBeenCalled();
    expect(after.nameSync).toEqual({ unconfirmed: PENDING });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT re-sent'));
    error.mockRestore();
  });

  it("the sweep's server clock is noted: a later rename's base is dated by it", async () => {
    resetServerClockForTests();
    await sweep(pendingRow(), 'Old', { nameSync: settler(), serverNow: T + 2_000 });
    expect(serverTimeSeen('u1')).toBe(T + 2_000);
  });

  it("the server's clock exactly the margin before the bound: re-sent", async () => {
    const s = settler();
    await sweep(pendingRow(), 'Old', {
      nameSync: s,
      serverNow: T + BUNDLE_SERVER_TIME_SKEW_MS - RENAME_RESEND_MARGIN_MS,
    });
    expect(s.resend).toHaveBeenCalled();
  });

  it("the server's clock more than the bound BEFORE the signed sentAt: not re-sent", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = settler();
    const { row: after } = await sweep(pendingRow(), 'Old', {
      nameSync: s,
      serverNow: T - BUNDLE_SERVER_TIME_SKEW_MS - 1,
    });
    expect(s.resend).not.toHaveBeenCalled();
    expect(after.nameSync).toEqual({ unconfirmed: PENDING });
    error.mockRestore();
  });

  // ROUND 8, item 3: an unknown is not a refusal. A phone build reaches the stores before production
  // serves the exposed header; shelving every rename swept then lost them for good.
  it('the server states no clock: still pending, said once per frame, re-sent once a clock is readable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const frame = { ...PENDING, messageId: 'clockless-frame-1' };
    const held = row({ name: 'Old', nameAt: T - 1_000, nameSync: { pending: frame } });
    const s = settler();
    const first = await sweep(held, 'Old', { nameSync: s, serverNow: null });
    const second = await sweep(first.row, 'Old', { nameSync: s, serverNow: null });
    expect(s.resend).not.toHaveBeenCalled();
    expect(second.row.nameSync).toEqual({ pending: frame });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('no readable clock'))).toHaveLength(
      1
    );
    await sweep(second.row, 'Old', { nameSync: s, serverNow: T + 1_000 });
    expect(s.resend).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  // ROUND 8, item 4: the read is answered by TYPE, never a null that lumps a gone group with a
  // transport failure.
  it('the group row read unanswered: still pending, for the next sweep', async () => {
    const s = settler();
    const { row: after, log } = await sweep(pendingRow(), 'Old', { nameSync: s, status: 'error' });
    expect(s.resend).not.toHaveBeenCalled();
    expect(after.nameSync).toEqual({ pending: PENDING });
    expect(said(log)).toContain('still pending');
  });

  for (const status of ['absent', 'deleted'] as const) {
    it(`a group the server holds no live row for (${status}): not re-sent, kept unconfirmed`, async () => {
      const s = settler();
      const { row: after, log } = await sweep(pendingRow(), 'Old', { nameSync: s, status });
      expect(s.resend).not.toHaveBeenCalled();
      expect(after.nameSync).toEqual({ unconfirmed: PENDING });
      expect(said(log)).toContain('no live group');
    });
  }

  it("within the server's bound: re-sent, whatever this device's clock says", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T + 10 * BUNDLE_SERVER_TIME_SKEW_MS);
    try {
      const s = settler();
      await sweep(pendingRow(), 'Old', { nameSync: s, serverNow: T + 1_000 });
      expect(s.resend).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unconfirmed frame alone is never re-sent by a sweep', async () => {
    const { row: after, nameSync } = await sweep(
      row({ name: 'Old', nameAt: T - 1_000, nameSync: { unconfirmed: PENDING } }),
      'Old'
    );
    expect(nameSync!.resend).not.toHaveBeenCalled();
    expect(after.nameSync).toEqual({ unconfirmed: PENDING });
  });
});

/**
 * THE ONE-TIME RESTATEMENT OF AN UNDATED NAME (sealed-names.md, step 2). A group that existed before
 * names were dated holds an undated name everywhere; the first member device of this build to sweep
 * it states that name once, silently, and every member dates it. "Once" is stored state: the date on
 * the row (persisted with its rank), or a record of a statement the server took without a time.
 */
describe('the one-time name statement of an undated group', () => {
  const STATED: NameStatementOutcome = { sent: { receivedAt: T + 60_000 } };

  /** A real `node:sqlite` engine behind the plugin's `execute`/`select` - the phone's store. */
  async function sqliteStore() {
    // Reached through `process.getBuiltinModule`, never an `import`: the test environment is a
    // browser one, and Vite refuses to bundle a Node built-in named in an import.
    const engine = new (process.getBuiltinModule('node:sqlite').DatabaseSync)(':memory:');
    const positional = (sql: string) => sql.replace(/\$(\d+)/g, '?$1');
    const db = {
      execute: async (sql: string, params: unknown[] = []) => {
        const result = engine.prepare(positional(sql)).run(...(params as never[]));
        return { rowsAffected: Number(result.changes) };
      },
      select: async (sql: string, params: unknown[] = []) =>
        engine.prepare(positional(sql)).all(...(params as never[])),
      close: async () => undefined,
    };
    vi.doMock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => db } }));
    const storage = new SqliteStorage(`statement-${crypto.randomUUID()}`);
    await storage.init();
    return storage;
  }

  /** One connection's sweep over `conversations`, each save written through the real store. */
  async function connect(
    conversations: Map<string, Conversation>,
    storage: SqliteStorage,
    serverName: string,
    opts: {
      state?: NameStatementOutcome;
      drained?: boolean | (() => boolean);
      /** The first-drained waiter, when the test drives it. */
      whenDrained?: Promise<void>;
      serverNow?: number;
      resend?: NameSyncSettler['resend'];
      /** What an owed answer's send comes to. */
      answer?: NameStatementOutcome;
    } = {}
  ) {
    const state = vi.fn().mockResolvedValue(opts.state ?? STATED);
    const answer = vi.fn().mockResolvedValue(opts.answer ?? STATED);
    const resend = opts.resend ?? vi.fn().mockResolvedValue({ kept: 'unanswered' });
    const meta = {
      groupId: GROUP_ID,
      name: serverName,
      isGroup: true,
      deletedAt: null,
      serverNow: opts.serverNow ?? T + 60_000,
    };
    const log = vi.fn();
    await ensureConversationForServerGroup(listed(serverName), {
      mlsService: {
        renameGroup: vi.fn(),
        getGroupMeta: vi.fn().mockResolvedValue(meta),
        getGroupServerStatus: vi.fn().mockResolvedValue(meta),
        isGroupDrained: () =>
          typeof opts.drained === 'function' ? opts.drained() : (opts.drained ?? true),
        whenGroupDrained: () => opts.whenDrained ?? Promise.resolve(),
      } as unknown as IMlsService,
      userId: 'u1',
      conversations,
      saveConversation: async (key) => {
        await storage.saveConversation(toConversationMeta(key, conversations.get(key)!, 'u1'));
      },
      owedExits: new Set<string>(),
      log,
      nameSync: { resend, state, answer, clock: newSweepClock() },
    });
    return { state, log, resend, answer };
  }

  /** What a restart reads back: the row rebuilt from the store alone. */
  async function restart(storage: SqliteStorage) {
    const meta = await storage.getConversation(GROUP_ID);
    return new Map([[GROUP_ID, restoredConversationRow(meta!, 'u1')]]);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('@tauri-apps/plugin-sql');
    vi.restoreAllMocks();
  });

  it('states the name once, dates the row at a statement rank, and a restart states nothing again', async () => {
    const storage = await sqliteStore();
    const phone = new Map([[GROUP_ID, row({ name: 'Les ROOTz' })]]);
    const first = await connect(phone, storage, 'Les ROOTz');
    expect(first.state).toHaveBeenCalledTimes(1);
    expect(first.state.mock.calls[0][0]).toMatchObject({ name: 'Les ROOTz', sentAt: T });
    expect(phone.get(GROUP_ID)).toMatchObject({
      name: 'Les ROOTz',
      nameAt: T + 60_000,
      nameFromStatement: true,
    });
    expect(phone.get(GROUP_ID)!.nameSync).toBeUndefined();

    // ONCE IS STORED STATE: the row read back from the store alone carries the date and its rank.
    const reopened = await restart(storage);
    expect(reopened.get(GROUP_ID)).toMatchObject({ nameAt: T + 60_000, nameFromStatement: true });
    const second = await connect(reopened, storage, 'Les ROOTz');
    expect(second.state).not.toHaveBeenCalled();
  });

  it('answered with no server time: recorded as answered, and never stated again - restart included', async () => {
    const storage = await sqliteStore();
    const phone = new Map([[GROUP_ID, row({ name: 'Les ROOTz' })]]);
    await connect(phone, storage, 'Les ROOTz', { state: { sent: { receivedAt: null } } });
    expect(phone.get(GROUP_ID)!.nameAt).toBeUndefined();
    expect(phone.get(GROUP_ID)!.nameSync?.statement).toMatchObject({ answered: true });
    const again = await connect(await restart(storage), storage, 'Les ROOTz');
    expect(again.state).not.toHaveBeenCalled();
  });

  it('no answer: the next connection re-sends the SAME frame - one statement, however many copies', async () => {
    const storage = await sqliteStore();
    const phone = new Map([[GROUP_ID, row({ name: 'Les ROOTz' })]]);
    const first = await connect(phone, storage, 'Les ROOTz', { state: { kept: 'unanswered' } });
    const minted = first.state.mock.calls[0][0];
    expect(phone.get(GROUP_ID)!.nameSync?.statement).toEqual(minted);

    vi.setSystemTime(T + 3_600_000);
    const reopened = await restart(storage);
    const second = await connect(reopened, storage, 'Les ROOTz', { serverNow: T + 3_600_000 });
    expect(second.state).toHaveBeenCalledTimes(1);
    expect(second.state.mock.calls[0][0]).toEqual(minted);
    expect(reopened.get(GROUP_ID)).toMatchObject({ nameFromStatement: true });
    expect(reopened.get(GROUP_ID)!.nameSync).toBeUndefined();
  });

  it('A1: an answer owed when the app stopped - drain never reached - is sent by the next connection, once', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const storage = await sqliteStore();
    const held = row({ name: 'Nouveau', nameAt: T - 5_000, nameRenamedBy: 'u1' });
    const phone = new Map([[GROUP_ID, held]]);
    await storage.saveConversation(toConversationMeta(GROUP_ID, held, 'u1'));
    // The statement is read live; the drain that would send the answer never comes (the app stops).
    const owed = await answerOutrankedStatement({
      mlsService: {
        isGroupDrained: () => false,
        whenGroupDrained: () => new Promise<void>(() => {}),
      } as unknown as IMlsService,
      userId: 'u1',
      send: vi.fn(),
      conversations: phone,
      convoKey: GROUP_ID,
      statedName: 'Ancien',
      statement: { id: 's-1', isAnswer: false },
      save: async (key) => {
        await storage.saveConversation(toConversationMeta(key, phone.get(key)!, 'u1'));
      },
      log: vi.fn(),
    });
    expect(owed).toBe(true);

    // RESTART: the debt is read back from the store alone, and the sweep sends it.
    const reopened = await restart(storage);
    expect(reopened.get(GROUP_ID)).toMatchObject({
      nameRenamedBy: 'u1',
      nameSync: { answer: { to: 's-1' } },
    });
    const first = await connect(reopened, storage, 'Nouveau');
    expect(first.answer).toHaveBeenCalledTimes(1);
    expect(first.answer.mock.calls[0][0]).toMatchObject({ name: 'Nouveau', renameAt: T - 5_000 });
    expect(first.answer.mock.calls[0][1]).toBe('s-1');
    expect(first.state).not.toHaveBeenCalled();
    // Settled - and once settled, never again, restart included.
    const second = await connect(await restart(storage), storage, 'Nouveau');
    expect(second.answer).not.toHaveBeenCalled();
  });

  it('A1: an answer whose send got no answer is re-sent by the next connection as the SAME frame', async () => {
    const storage = await sqliteStore();
    const held = row({
      name: 'Nouveau',
      nameAt: T - 5_000,
      nameRenamedBy: 'u1',
      nameSync: { answer: { to: 's-1' } },
    });
    const first = await connect(new Map([[GROUP_ID, held]]), storage, 'Nouveau', {
      answer: { kept: 'unanswered' },
    });
    const frame = first.answer.mock.calls[0][0];
    vi.setSystemTime(T + 3_600_000);
    const second = await connect(await restart(storage), storage, 'Nouveau', {
      serverNow: T + 3_600_000,
    });
    expect(second.answer).toHaveBeenCalledTimes(1);
    expect(second.answer.mock.calls[0][0]).toEqual(frame);
  });

  it('A1: a later rename by someone else makes an owed answer void - settled unsent', async () => {
    const storage = await sqliteStore();
    const held = row({
      name: 'Autre',
      nameAt: T,
      nameRenamedBy: 'someone-else',
      nameSync: { answer: { to: 's-1' } },
    });
    const phone = new Map([[GROUP_ID, held]]);
    const sweep1 = await connect(phone, storage, 'Autre');
    expect(sweep1.answer).not.toHaveBeenCalled();
    expect(phone.get(GROUP_ID)!.nameSync).toEqual({ answer: { to: 's-1', done: true } });
  });

  it('an undrained group is CHAINED on its first drain - never skipped to the next sweep, one chain at a time', async () => {
    const storage = await sqliteStore();
    const phone = new Map([[GROUP_ID, row({ name: 'Les ROOTz' })]]);
    let drainedNow = false;
    let drain!: () => void;
    const whenDrained = new Promise<void>((resolve) => (drain = resolve));
    const drained = () => drainedNow;
    const first = await connect(phone, storage, 'Les ROOTz', { drained, whenDrained });
    expect(first.state).not.toHaveBeenCalled();
    expect(said(first.log)).toContain('waits for this link to drain');
    // A second sweep while the chain waits adds no chain and says nothing.
    const second = await connect(phone, storage, 'Les ROOTz', { drained, whenDrained });
    expect(said(second.log)).not.toContain('waits for this link to drain');
    drainedNow = true;
    drain();
    // The chain states the name once the group drained - once, through the first sweep's chain.
    await vi.waitFor(() => expect(phone.get(GROUP_ID)!.nameFromStatement).toBe(true));
    expect(first.state).toHaveBeenCalledTimes(1);
    expect(second.state).not.toHaveBeenCalled();
  });

  it("never states a name the server's list does not hold: a raw id never becomes the members' word", async () => {
    const storage = await sqliteStore();
    for (const held of [GROUP_ID, '']) {
      const phone = new Map([[GROUP_ID, row({ name: held })]]);
      const { state } = await connect(phone, storage, '');
      expect(state).not.toHaveBeenCalled();
    }
  });

  it("never while a rename of this device's own is pending: its re-send compares the row's date", async () => {
    const storage = await sqliteStore();
    const pending = {
      name: 'New',
      messageId: 'f0000000-0000-4000-8000-000000000001',
      sentAt: T - 1_000,
      over: { name: 'Les ROOTz' },
    };
    const phone = new Map([[GROUP_ID, row({ name: 'Les ROOTz', nameSync: { pending } })]]);
    const { state } = await connect(phone, storage, 'Les ROOTz');
    expect(state).not.toHaveBeenCalled();
  });

  it("this device's clock outside the receivers' bound: nothing is stated, and it is said", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = await sqliteStore();
    const phone = new Map([[GROUP_ID, row({ name: 'Les ROOTz' })]]);
    const { state } = await connect(phone, storage, 'Les ROOTz', {
      serverNow: T + 2 * BUNDLE_SERVER_TIME_SKEW_MS,
    });
    expect(state).not.toHaveBeenCalled();
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain('NOT sent this sweep');
  });

  it("an older build's undated rename (the server's list only) still loses to the stated name", async () => {
    const storage = await sqliteStore();
    const phone = new Map([[GROUP_ID, row({ name: 'Les ROOTz' })]]);
    await connect(phone, storage, 'Les ROOTz');
    // An older build renames through the server's list alone - nothing a device of this build can
    // date - and the dated name stands.
    const { state } = await connect(phone, storage, 'Renamed by an old build');
    expect(phone.get(GROUP_ID)!.name).toBe('Les ROOTz');
    expect(state).not.toHaveBeenCalled();
  });

  it("the server's clock is read ONCE per sweep, and a skewed device clock said once per sweep, not per group", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const other = 'e4c1f0aa-0000-4000-8000-0000000000b2';
    const conversations = new Map<string, Conversation>([
      [GROUP_ID, row({ name: 'A' })],
      [other, row({ id: other, contactName: other, name: 'B' })],
    ]);
    const meta = {
      name: 'x',
      isGroup: true,
      deletedAt: null,
      serverNow: T + 2 * BUNDLE_SERVER_TIME_SKEW_MS,
    };
    const getGroupServerStatus = vi.fn().mockResolvedValue(meta);
    const settler = { resend: vi.fn(), state: vi.fn(), answer: vi.fn(), clock: newSweepClock() };
    for (const [id, name] of [
      [GROUP_ID, 'A'],
      [other, 'B'],
    ]) {
      await ensureConversationForServerGroup(
        { groupId: id, name, isGroup: true },
        {
          mlsService: {
            getGroupServerStatus,
            isGroupDrained: () => true,
          } as unknown as IMlsService,
          userId: 'u1',
          conversations,
          owedExits: new Set<string>(),
          log: vi.fn(),
          nameSync: settler,
        }
      );
    }
    expect(getGroupServerStatus).toHaveBeenCalledTimes(1);
    expect(settler.state).not.toHaveBeenCalled();
    expect(
      error.mock.calls.filter((c) => String(c[0]).includes('NOT sent this sweep'))
    ).toHaveLength(1);
  });
});
