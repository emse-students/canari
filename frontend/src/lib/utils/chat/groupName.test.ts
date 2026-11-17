import { describe, expect, it, vi } from 'vitest';
import {
  applyRenameFrame,
  boundedRestatedGroupName,
  groupNameSupersedes,
  ownRenameOutcome,
  readDatedGroupName,
  readRenameFrame,
  restatedGroupName,
  withDatedGroupName,
  withRestatedGroupName,
  nameSyncField,
  ownRenameFromRelay,
  parseNameSync,
  unconfirmedFrom,
  pendingRenameOutcome,
  pendingRenameVerdict,
  reportRenameRefusal,
} from './groupName';
import { BUNDLE_SERVER_TIME_SKEW_MS } from './messageTime';
import type { Conversation } from '$lib/types';

const T = Date.UTC(2026, 10, 17, 9, 0, 0);

function group(extra: Partial<Conversation> = {}): Conversation {
  return {
    id: 'g1',
    contactName: 'g1',
    name: 'Groupe',
    messages: [],
    lifecycle: 'active',
    mlsStateHex: null,
    conversationType: 'group',
    ...extra,
  };
}

/** The row a statement produced, or a failure naming what came back instead. */
function rowOf(out: { row: Conversation } | { skipped: string } | { refused: string }) {
  if (!('row' in out)) throw new Error(`no row: ${JSON.stringify(out)}`);
  return out.row;
}

describe('a group name is ordered by the server time of the frame that stated it', () => {
  it('any dated statement beats an undated name (one from the server list)', () => {
    expect(groupNameSupersedes({ name: 'A', at: T }, { name: 'Groupe' })).toBe(true);
  });

  it('the later statement wins, whatever order it is read in', () => {
    const older = { name: 'Old', at: T };
    const newer = { name: 'New', at: T + 1000 };
    const afterNewer = rowOf(withDatedGroupName(group(), newer));
    expect(withDatedGroupName(afterNewer, older)).toEqual({ skipped: 'not-newer' });
    const afterOlder = rowOf(withDatedGroupName(group(), older));
    expect(rowOf(withDatedGroupName(afterOlder, newer)).name).toBe('New');
  });

  it('a tie is settled by the larger name, so two devices agree from either arrival order', () => {
    const a = { name: 'Alpha', at: T };
    const b = { name: 'Beta', at: T };
    expect(rowOf(withDatedGroupName(rowOf(withDatedGroupName(group(), a)), b)).name).toBe('Beta');
    expect(withDatedGroupName(rowOf(withDatedGroupName(group(), b)), a)).toEqual({
      skipped: 'not-newer',
    });
  });

  it('only a group row takes one, and says so: a DM and a channel keep their own names', () => {
    expect(withDatedGroupName(group({ conversationType: 'direct' }), { name: 'X', at: T })).toEqual(
      { skipped: 'not-a-group' }
    );
    expect(
      withDatedGroupName(group({ conversationType: 'channel' }), { name: 'X', at: T })
    ).toEqual({ skipped: 'not-a-group' });
  });

  it('writes the date beside the name', () => {
    expect(rowOf(withDatedGroupName(group(), { name: 'Les ROOTz', at: T }))).toMatchObject({
      name: 'Les ROOTz',
      nameAt: T,
    });
  });
});

describe('what is read off the wire, refused by its real cause', () => {
  it('names each cause apart: no name, an empty one, no server time', () => {
    expect(readDatedGroupName(42, T)).toEqual({ refused: 'not-a-name' });
    expect(readDatedGroupName('  ', T)).toEqual({ refused: 'empty-name' });
    expect(readDatedGroupName('A', undefined)).toEqual({ refused: 'no-server-time' });
    expect(readDatedGroupName('A', 0)).toEqual({ refused: 'no-server-time' });
    expect(readDatedGroupName('A', Number.NaN)).toEqual({ refused: 'no-server-time' });
    expect(readDatedGroupName(' A ', T)).toEqual({ kept: { name: 'A', at: T } });
  });

  it('a server time far from the signed sentAt is not believed: a far-future stamp locks nothing in', () => {
    expect(readRenameFrame('A', T + 2_000, T)).toEqual({ kept: { name: 'A', at: T + 2_000 } });
    expect(readRenameFrame('A', T + BUNDLE_SERVER_TIME_SKEW_MS + 1, T)).toEqual({
      refused: 'server-time-out-of-bound',
    });
    expect(readRenameFrame('A', Date.UTC(2100, 0, 1), T)).toEqual({
      refused: 'server-time-out-of-bound',
    });
    expect(readRenameFrame('A', T - BUNDLE_SERVER_TIME_SKEW_MS - 1, T)).toEqual({
      refused: 'server-time-out-of-bound',
    });
    expect(readRenameFrame('A', T, undefined)).toEqual({ refused: 'no-signed-time' });
  });

  it('applyRenameFrame is the read, the bound and the order in one', () => {
    expect(applyRenameFrame(group(), '', T, T)).toEqual({ refused: 'empty-name' });
    expect(applyRenameFrame(group({ conversationType: 'direct' }), 'A', T, T)).toEqual({
      skipped: 'not-a-group',
    });
    expect(rowOf(applyRenameFrame(group(), 'A', T, T))).toMatchObject({ name: 'A', nameAt: T });
  });

  it('a join push restates only a name a frame dated', () => {
    expect(restatedGroupName({ name: 'Groupe' })).toBeUndefined();
    expect(restatedGroupName({ name: 'Groupe', nameAt: T })).toEqual({ name: 'Groupe', at: T });
  });

  it('a restated date later than the push carrying it was not the server`s, and is refused', () => {
    expect(boundedRestatedGroupName({ name: 'A', at: T }, T)).toEqual({
      kept: { name: 'A', at: T },
    });
    expect(boundedRestatedGroupName({ name: 'A', at: T + 1 }, T)).toEqual({
      refused: 'after-the-push',
    });
    expect(boundedRestatedGroupName({ name: 'A', at: T }, undefined)).toEqual({
      refused: 'no-server-time',
    });
    expect(boundedRestatedGroupName('A', T)).toEqual({ refused: 'not-a-name' });
  });

  it('a restated name never beats a frame this device read: an inviter cannot rename for the newcomer', () => {
    const dated = group({ name: 'Les ROOTz', nameAt: T });
    expect(withRestatedGroupName(dated, { name: 'Faux', at: T + 10 })).toEqual({
      skipped: 'already-dated',
    });
    expect(rowOf(withRestatedGroupName(group(), { name: 'Les ROOTz', at: T }))).toMatchObject({
      name: 'Les ROOTz',
      nameAt: T,
    });
  });
});

describe("the acting device's own rename, written over the row as it is AFTER the send", () => {
  const OVER = { name: 'Old', at: T };

  it("a peer's later rename applied during the send stays", () => {
    const meanwhile = group({ name: 'B', nameAt: T + 5_000 });
    expect(ownRenameOutcome(meanwhile, 'A', T, false, OVER)).toEqual({ skipped: 'not-newer' });
  });

  it('dated by the answer when newer', () => {
    expect(rowOf(ownRenameOutcome(group({ nameAt: T }), 'A', T + 1, false, OVER))).toMatchObject({
      name: 'A',
      nameAt: T + 1,
    });
  });

  it('with no server time in the answer the row is written undated, never under an older date', () => {
    const row = rowOf(ownRenameOutcome(group({ name: 'Old', nameAt: T }), 'A', null, false, OVER));
    expect(row.name).toBe('A');
    expect('nameAt' in row).toBe(false);
  });

  it('an owed server copy is recorded by NAME and the server name it goes over', () => {
    expect(rowOf(ownRenameOutcome(group({ nameAt: T }), 'A', T + 1, true, OVER))).toMatchObject({
      name: 'A',
      nameAt: T + 1,
      nameSync: { serverCopy: { name: 'A', from: 'Old' } },
    });
  });

  it('an UNDATED rename owes its copy too - the marker is not lost with the date', () => {
    const row = rowOf(ownRenameOutcome(group({ name: 'Old', nameAt: T }), 'A', null, true, OVER));
    expect('nameAt' in row).toBe(false);
    expect(row.nameSync).toEqual({ serverCopy: { name: 'A', from: 'Old' } });
  });

  it('a rename whose server copy was written clears what an older one owed, a pending frame too', () => {
    const owing = group({
      nameAt: T,
      nameSync: {
        serverCopy: { name: 'Older', from: 'X' },
        pending: { name: 'P', messageId: 'm1', sentAt: T, over: { name: 'Older' } },
      },
    });
    const row = rowOf(ownRenameOutcome(owing, 'A', T + 1, false, OVER));
    expect('nameSync' in row).toBe(false);
  });
});

describe('a rename whose frame got no answer', () => {
  const PENDING = { name: 'A', messageId: 'm1', sentAt: T, over: { name: 'Old', at: T - 1 } };

  it('keeps the name shown and records the frame, beside an older owed copy', () => {
    const row = rowOf(
      pendingRenameOutcome(
        group({ name: 'Old', nameAt: T - 1, nameSync: { serverCopy: { name: 'Old', from: 'Z' } } }),
        PENDING
      )
    );
    expect(row.name).toBe('Old');
    expect(row.nameAt).toBe(T - 1);
    expect(row.nameSync).toEqual({ serverCopy: { name: 'Old', from: 'Z' }, pending: PENDING });
  });

  it('a second unanswered rename moves the first frame to unconfirmed - its id is the only heal', () => {
    const second = { ...PENDING, name: 'A2', messageId: 'm2', sentAt: T + 9 };
    const row = rowOf(
      pendingRenameOutcome(
        group({ name: 'Old', nameAt: T - 1, nameSync: { pending: PENDING } }),
        second
      )
    );
    expect(row.nameSync).toEqual({ pending: second, unconfirmed: PENDING });
  });

  it("a join push dating the undated name a pending rename was made over dates that rename's base", () => {
    const undated = { ...PENDING, over: { name: 'Old' } };
    const row = rowOf(
      withRestatedGroupName(group({ name: 'Old', nameSync: { pending: undated } }), {
        name: 'Old',
        at: T - 500,
      })
    );
    expect(row.nameSync?.pending?.over).toEqual({ name: 'Old', at: T - 500 });
    expect(pendingRenameVerdict(row, row.nameSync!.pending!)).toBe('resend');
  });

  // ROUND 7, F1: every path dating a row goes through `withDatedGroupName`, a replayed frame too.
  // The archive replaying the frame that set "Old" at T0 used to date the row and leave the base
  // undated, so the sweep read it as superseded and never sent a rename the person was told was on
  // its way.
  it('a replayed frame that set the undated base before the rename dates that base: still re-sent', () => {
    const undated = { ...PENDING, over: { name: 'Old' } };
    const row = rowOf(
      applyRenameFrame(
        group({ name: 'Old', nameSync: { pending: undated } }),
        'Old',
        T - 500,
        T - 600
      )
    );
    expect(row).toMatchObject({ name: 'Old', nameAt: T - 500 });
    expect(row.nameSync?.pending?.over).toEqual({ name: 'Old', at: T - 500 });
    expect(pendingRenameVerdict(row, row.nameSync!.pending!)).toBe('resend');
  });

  it('the same name stated AFTER the rename was minted is a later statement: the base stays undated', () => {
    const undated = { ...PENDING, over: { name: 'Old' } };
    const row = rowOf(
      withDatedGroupName(group({ name: 'Old', nameSync: { pending: undated } }), {
        name: 'Old',
        at: T + 5,
      })
    );
    expect(row.nameSync?.pending?.over).toEqual({ name: 'Old' });
    expect(pendingRenameVerdict(row, row.nameSync!.pending!)).toBe('superseded');
  });

  it('is re-sent only while the row still holds what it was made over', () => {
    expect(pendingRenameVerdict({ name: 'Old', nameAt: T - 1 }, PENDING)).toBe('resend');
    expect(pendingRenameVerdict({ name: 'B', nameAt: T + 9 }, PENDING)).toBe('superseded');
    // The same name under ANOTHER date is another statement (Old -> B -> Old): never re-sent over.
    expect(pendingRenameVerdict({ name: 'Old', nameAt: T + 9 }, PENDING)).toBe('superseded');
    expect(pendingRenameVerdict({ name: 'Old' }, PENDING)).toBe('superseded');
    // An undated base is re-sent while the row is still undated.
    const undated = { ...PENDING, over: { name: 'Old' } };
    expect(pendingRenameVerdict({ name: 'Old' }, undated)).toBe('resend');
    expect(pendingRenameVerdict({ name: 'Old', nameAt: T + 9 }, undated)).toBe('superseded');
    // Its own frame came back from the archive: it landed.
    expect(pendingRenameVerdict({ name: 'A', nameAt: T + 2 }, PENDING)).toBe('landed');
  });
});

describe('the heal of an own rename whose fate was never learnt: a relayed copy of its notice', () => {
  // S renamed to "A"; its send got no answer, it stopped re-sending (a later name, the 24 h bound,
  // a refusal). The members hold the notice under the id S minted; S holds no row under it, so the
  // history reconciliation's digest diff relays that row - and it is the proof the frame landed.
  const FRAME = { name: 'A', messageId: 'own-1', sentAt: T, over: { name: 'Old', at: T - 1 } };

  it('a relayed row under its id applies (A, t1) at the time the members dated it, and owes the copy', () => {
    const s = group({ name: 'Old', nameAt: T - 1, nameSync: { unconfirmed: FRAME } });
    const out = ownRenameFromRelay(s, [{ id: 'own-1', serverTimestamp: T + 5, renamedTo: 'A' }]);
    expect(out).toMatchObject({ outcome: 'applied' });
    const healed = (out as { row: Conversation }).row;
    expect(healed).toMatchObject({ name: 'A', nameAt: T + 5 });
    expect(healed.nameSync).toEqual({ serverCopy: { name: 'A', from: 'Old' } });
  });

  it('A landed BEFORE the later B this device holds: B stands, as it does for every member', () => {
    const s = group({ name: 'B', nameAt: T + 10, nameSync: { unconfirmed: FRAME } });
    const out = ownRenameFromRelay(s, [{ id: 'own-1', serverTimestamp: T + 5, renamedTo: 'A' }]);
    expect(out).toMatchObject({ outcome: 'older' });
    const kept = (out as { row: Conversation }).row;
    expect(kept).toMatchObject({ name: 'B', nameAt: T + 10 });
    expect(kept.nameSync).toBeUndefined();
  });

  it('A landed AFTER B: the members hold A, and so does this device now', () => {
    const s = group({ name: 'B', nameAt: T + 3, nameSync: { unconfirmed: FRAME } });
    const out = ownRenameFromRelay(s, [{ id: 'own-1', serverTimestamp: T + 5, renamedTo: 'A' }]);
    expect((out as { row: Conversation }).row).toMatchObject({ name: 'A', nameAt: T + 5 });
  });

  it('settles a frame still pending too: it landed, nothing is re-sent', () => {
    const s = group({ name: 'Old', nameAt: T - 1, nameSync: { pending: FRAME } });
    const out = ownRenameFromRelay(s, [{ id: 'own-1', serverTimestamp: T + 5, renamedTo: 'A' }]);
    expect((out as { row: Conversation }).row.nameSync).toEqual({
      serverCopy: { name: 'A', from: 'Old' },
    });
  });

  it("the relayer's server time is bounded by the sentAt THIS device minted", () => {
    const s = group({ name: 'Old', nameAt: T - 1, nameSync: { unconfirmed: FRAME } });
    const far = T + BUNDLE_SERVER_TIME_SKEW_MS + 1;
    expect(
      ownRenameFromRelay(s, [{ id: 'own-1', serverTimestamp: far, renamedTo: 'A' }])
    ).toMatchObject({ refused: 'server-time-out-of-bound' });
    expect(ownRenameFromRelay(s, [{ id: 'own-1', renamedTo: 'A' }])).toMatchObject({
      refused: 'no-server-time',
    });
  });

  it('a row under its id naming another name is refused; rows under other ids are not its business', () => {
    const s = group({ name: 'Old', nameAt: T - 1, nameSync: { unconfirmed: FRAME } });
    expect(
      ownRenameFromRelay(s, [{ id: 'own-1', serverTimestamp: T + 5, renamedTo: 'Z' }])
    ).toMatchObject({ refused: 'other-name' });
    expect(
      ownRenameFromRelay(s, [{ id: 'other', serverTimestamp: T + 5, renamedTo: 'A' }])
    ).toBeNull();
    expect(
      ownRenameFromRelay(group({ name: 'Old' }), [{ id: 'own-1', renamedTo: 'A' }])
    ).toBeNull();
  });

  it('a frame moved to unconfirmed leaves pending, and the record round-trips', () => {
    const sync = unconfirmedFrom({ pending: FRAME, serverCopy: { name: 'P', from: 'Q' } }, FRAME);
    expect(nameSyncField(sync).nameSync).toEqual({
      serverCopy: { name: 'P', from: 'Q' },
      unconfirmed: FRAME,
    });
    expect(parseNameSync(JSON.stringify({ unconfirmed: FRAME }))).toEqual({ unconfirmed: FRAME });
  });
});

describe('the stored name sync', () => {
  const PENDING = { name: 'A', messageId: 'm1', sentAt: T, over: { name: 'Old' } };

  it('round-trips through JSON, and an empty record reads as nothing owed', () => {
    const sync = { serverCopy: { name: 'A', from: 'Old' }, pending: PENDING };
    expect(parseNameSync(JSON.stringify(sync))).toEqual(sync);
    expect(parseNameSync(sync)).toEqual(sync);
    expect(parseNameSync(null)).toBeUndefined();
    expect(parseNameSync('{}')).toBeUndefined();
  });

  it('says so when a stored value does not parse, and drops only the unreadable half', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseNameSync('not json')).toBeUndefined();
    expect(
      parseNameSync({ serverCopy: { name: 'A', from: 'Old' }, pending: { name: 'A' } })
    ).toEqual({ serverCopy: { name: 'A', from: 'Old' } });
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});

describe('a refused rename frame is reported', () => {
  it('a legacy frame without a signed sentAt is said ONCE per conversation, at INFO', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportRenameRefusal('conv-legacy-1', 'no-signed-time', 'rename by abcd');
    reportRenameRefusal('conv-legacy-1', 'no-signed-time', 'replayed rename');
    reportRenameRefusal('conv-legacy-2', 'no-signed-time', 'rename by abcd');
    expect(info).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
    info.mockRestore();
    error.mockRestore();
  });

  it('any other refusal is an error, every time', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportRenameRefusal('conv-x', 'server-time-out-of-bound', 'rename by abcd');
    reportRenameRefusal('conv-x', 'server-time-out-of-bound', 'rename by abcd');
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
