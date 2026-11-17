/**
 * WHAT A RENAME STILL OWES, SETTLED BY THE CONNECTION SWEEP (`settleNameSync`).
 *
 * Two halves. The SERVER'S COPY of a name the members hold is written compare-and-set: only while the
 * row holds that name and the server still holds the name the rename was made over - a server naming
 * anything else was written by a later rename, and an owed copy put an older name back over it
 * (#3785 re-review P2-a). The PENDING FRAME - a send that got no answer, its fate unknown - is re-sent
 * as the same frame while the row still holds what it was made over, and dropped once anything else
 * settled it (P2-b). The recovery path, which runs before the device drained what it missed, neither
 * settles nor relabels a row that owes something.
 */
import type { Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { PendingRename } from './groupName';
import { BUNDLE_SERVER_TIME_SKEW_MS } from './messageTime';
import {
  ensureConversationForServerGroup,
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

function settler(over: Partial<NameSyncSettler> = {}): NameSyncSettler {
  return {
    resend: vi.fn().mockResolvedValue({ receivedAt: T + 60_000, sentAt: T + 59_000 }),
    now: () => T + 60_000,
    ...over,
  };
}

async function sweep(
  held: Conversation,
  serverName: string,
  opts: { nameSync?: NameSyncSettler | null; renameGroup?: ReturnType<typeof vi.fn> } = {}
) {
  const conversations = new Map<string, Conversation>([[GROUP_ID, held]]);
  const renameGroup = opts.renameGroup ?? vi.fn().mockResolvedValue(undefined);
  const log = vi.fn();
  const nameSync = opts.nameSync === null ? undefined : (opts.nameSync ?? settler());
  await ensureConversationForServerGroup(listed(serverName), {
    mlsService: { renameGroup } as unknown as IMlsService,
    userId: 'u1',
    conversations,
    saveConversation: vi.fn(async () => {}),
    owedExits: new Set<string>(),
    log,
    ...(nameSync ? { nameSync } : {}),
  });
  return { row: conversations.get(GROUP_ID)!, renameGroup, log, nameSync };
}

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

  it('no answer again: still pending, nothing else written', async () => {
    const s = settler({ resend: vi.fn().mockResolvedValue('unanswered') });
    const { row: after, renameGroup } = await sweep(pendingRow(), 'Old', { nameSync: s });
    expect(after.name).toBe('Old');
    expect(after.nameSync).toEqual({ pending: PENDING });
    expect(renameGroup).not.toHaveBeenCalled();
  });

  it('an ANSWERED refusal of the re-send drops it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = settler({ resend: vi.fn().mockRejectedValue(new Error('403')) });
    const { row: after } = await sweep(pendingRow(), 'Old', { nameSync: s });
    expect(after.name).toBe('Old');
    expect(after.nameSync).toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('superseded by a later name read since: dropped, never re-sent over it', async () => {
    const { row: after, nameSync } = await sweep(pendingRow({ name: 'Y', nameAt: T + 5 }), 'Y');
    expect(nameSync!.resend).not.toHaveBeenCalled();
    expect(after.name).toBe('Y');
    expect(after.nameSync).toBeUndefined();
  });

  it('its own frame came back from the archive: not re-sent, only the server copy written', async () => {
    const {
      row: after,
      nameSync,
      renameGroup,
    } = await sweep(pendingRow({ name: 'X', nameAt: T + 30 }), 'Old');
    expect(nameSync!.resend).not.toHaveBeenCalled();
    expect(renameGroup).toHaveBeenCalledWith(GROUP_ID, 'X');
    expect(after.nameSync).toBeUndefined();
  });

  it('minted beyond the receivers bound: dropped unsent, since every member would refuse it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = settler({ now: () => T + BUNDLE_SERVER_TIME_SKEW_MS + 1 });
    const { row: after } = await sweep(pendingRow(), 'Old', { nameSync: s });
    expect(s.resend).not.toHaveBeenCalled();
    expect(after.nameSync).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('DROPPED unsent'));
    error.mockRestore();
  });
});
