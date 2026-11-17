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
import type { PendingRename } from './groupName';
import type { RenameResendOutcome } from './groupActions';
import { BUNDLE_SERVER_TIME_SKEW_MS } from './messageTime';
import {
  ensureConversationForServerGroup,
  RENAME_RESEND_MARGIN_MS,
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
