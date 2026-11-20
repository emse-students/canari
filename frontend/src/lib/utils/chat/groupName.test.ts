import { describe, expect, it, vi } from 'vitest';
import {
  applyNameStatement,
  applyRenameFrame,
  nameStatementDue,
  statementAnswerDue,
  answerReadSettlesOwn,
  owedAnswerDue,
  ownAnswerOutcome,
  withOwedAnswer,
  ownNameStatementOutcome,
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
    expect(applyRenameFrame(group(), '', T, T, 'bob')).toEqual({ refused: 'empty-name' });
    expect(applyRenameFrame(group({ conversationType: 'direct' }), 'A', T, T, 'bob')).toEqual({
      skipped: 'not-a-group',
    });
    expect(rowOf(applyRenameFrame(group(), 'A', T, T, 'bob'))).toMatchObject({
      name: 'A',
      nameAt: T,
    });
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
    expect(ownRenameOutcome(meanwhile, 'A', T, false, OVER, 'me')).toEqual({
      skipped: 'not-newer',
    });
  });

  it('dated by the answer when newer', () => {
    expect(
      rowOf(ownRenameOutcome(group({ nameAt: T }), 'A', T + 1, false, OVER, 'me'))
    ).toMatchObject({
      name: 'A',
      nameAt: T + 1,
    });
  });

  it('with no server time in the answer the row is written undated, never under an older date', () => {
    const row = rowOf(
      ownRenameOutcome(group({ name: 'Old', nameAt: T }), 'A', null, false, OVER, 'me')
    );
    expect(row.name).toBe('A');
    expect('nameAt' in row).toBe(false);
  });

  it('an owed server copy is recorded by NAME and the server name it goes over', () => {
    expect(
      rowOf(ownRenameOutcome(group({ nameAt: T }), 'A', T + 1, true, OVER, 'me'))
    ).toMatchObject({
      name: 'A',
      nameAt: T + 1,
      nameSync: { serverCopy: { name: 'A', from: 'Old' } },
    });
  });

  it('an UNDATED rename owes its copy too - the marker is not lost with the date', () => {
    const row = rowOf(
      ownRenameOutcome(group({ name: 'Old', nameAt: T }), 'A', null, true, OVER, 'me')
    );
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
    const row = rowOf(ownRenameOutcome(owing, 'A', T + 1, false, OVER, 'me'));
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
    const undated = { ...PENDING, over: { name: 'Old' }, serverSeenAt: T - 100 };
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
    const undated = { ...PENDING, over: { name: 'Old' }, serverSeenAt: T - 100 };
    const row = rowOf(
      applyRenameFrame(
        group({ name: 'Old', nameSync: { pending: undated } }),
        'Old',
        T - 500,
        T - 600,
        'bob'
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

  // ROUND 8, item 2: SERVER TIME AGAINST SERVER TIME. The statement's stamp is the server's; this
  // device's `sentAt` is its own clock, which may run ahead (A -> B -> A reopens) or behind (the
  // rename is never sent). The base is dated only by a stamp no later than a server time this
  // account had seen when it minted the frame.
  it('a stamp before the device clock but after the server time seen at mint is not provably earlier', () => {
    const undated = { ...PENDING, over: { name: 'Old' }, serverSeenAt: T - 1_000 };
    const row = rowOf(
      withDatedGroupName(group({ name: 'Old', nameSync: { pending: undated } }), {
        name: 'Old',
        at: T - 500,
      })
    );
    expect(row.nameSync?.pending?.over).toEqual({ name: 'Old' });
  });

  it('no server time seen at mint: nothing proves the statement earlier, the base stays undated', () => {
    const undated = { ...PENDING, sentAt: T + 10 * 60_000, over: { name: 'Old' } };
    const row = rowOf(
      withDatedGroupName(group({ name: 'Old', nameSync: { pending: undated } }), {
        name: 'Old',
        at: T - 500,
      })
    );
    expect(row.nameSync?.pending?.over).toEqual({ name: 'Old' });
  });

  it('the server time seen at mint is kept through a round trip of the stored value', () => {
    const withSeen = { ...PENDING, serverSeenAt: T - 1_000 };
    expect(parseNameSync(JSON.stringify({ pending: withSeen }))).toEqual({ pending: withSeen });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseNameSync({ pending: { ...PENDING, serverSeenAt: -1 } })).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unreadable half'));
    error.mockRestore();
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
    const out = ownRenameFromRelay(
      s,
      [{ id: 'own-1', serverTimestamp: T + 5, renamedTo: 'A' }],
      'me'
    );
    expect(out).toMatchObject({ outcome: 'applied' });
    const healed = (out as { row: Conversation }).row;
    expect(healed).toMatchObject({ name: 'A', nameAt: T + 5 });
    expect(healed.nameSync).toEqual({ serverCopy: { name: 'A', from: 'Old' } });
  });

  it('A landed BEFORE the later B this device holds: B stands, as it does for every member', () => {
    const s = group({ name: 'B', nameAt: T + 10, nameSync: { unconfirmed: FRAME } });
    const out = ownRenameFromRelay(
      s,
      [{ id: 'own-1', serverTimestamp: T + 5, renamedTo: 'A' }],
      'me'
    );
    expect(out).toMatchObject({ outcome: 'older' });
    const kept = (out as { row: Conversation }).row;
    expect(kept).toMatchObject({ name: 'B', nameAt: T + 10 });
    expect(kept.nameSync).toBeUndefined();
  });

  it('A landed AFTER B: the members hold A, and so does this device now', () => {
    const s = group({ name: 'B', nameAt: T + 3, nameSync: { unconfirmed: FRAME } });
    const out = ownRenameFromRelay(
      s,
      [{ id: 'own-1', serverTimestamp: T + 5, renamedTo: 'A' }],
      'me'
    );
    expect((out as { row: Conversation }).row).toMatchObject({ name: 'A', nameAt: T + 5 });
  });

  it('settles a frame still pending too: it landed, nothing is re-sent', () => {
    const s = group({ name: 'Old', nameAt: T - 1, nameSync: { pending: FRAME } });
    const out = ownRenameFromRelay(
      s,
      [{ id: 'own-1', serverTimestamp: T + 5, renamedTo: 'A' }],
      'me'
    );
    expect((out as { row: Conversation }).row.nameSync).toEqual({
      serverCopy: { name: 'A', from: 'Old' },
    });
  });

  it("the relayer's server time is bounded by the sentAt THIS device minted", () => {
    const s = group({ name: 'Old', nameAt: T - 1, nameSync: { unconfirmed: FRAME } });
    const far = T + BUNDLE_SERVER_TIME_SKEW_MS + 1;
    expect(
      ownRenameFromRelay(s, [{ id: 'own-1', serverTimestamp: far, renamedTo: 'A' }], 'me')
    ).toMatchObject({ refused: 'server-time-out-of-bound' });
    expect(ownRenameFromRelay(s, [{ id: 'own-1', renamedTo: 'A' }], 'me')).toMatchObject({
      refused: 'no-server-time',
    });
  });

  it('a row under its id naming another name is refused; rows under other ids are not its business', () => {
    const s = group({ name: 'Old', nameAt: T - 1, nameSync: { unconfirmed: FRAME } });
    expect(
      ownRenameFromRelay(s, [{ id: 'own-1', serverTimestamp: T + 5, renamedTo: 'Z' }], 'me')
    ).toMatchObject({ refused: 'other-name' });
    expect(
      ownRenameFromRelay(s, [{ id: 'other', serverTimestamp: T + 5, renamedTo: 'A' }], 'me')
    ).toBeNull();
    expect(
      ownRenameFromRelay(group({ name: 'Old' }), [{ id: 'own-1', renamedTo: 'A' }], 'me')
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

/**
 * STEP 2 (sealed-names.md): every group gets a dated name, by a SILENT `groupNamed` statement - at
 * creation, or the one-time restatement of a group that existed before names were dated. A statement
 * dates a name and never renames: it is ranked below every rename.
 */
describe('a silent name statement is ranked below every rename', () => {
  it('a rename beats a statement whatever the dates, and a statement never beats a rename', () => {
    const stated = { name: 'Groupe', at: T + 60_000, statement: true as const };
    const renamed = { name: 'Nouveau', at: T };
    expect(
      groupNameSupersedes(renamed, { name: 'Groupe', nameAt: T + 60_000, nameFromStatement: true })
    ).toBe(true);
    expect(groupNameSupersedes(stated, { name: 'Nouveau', nameAt: T })).toBe(false);
  });

  it('between two statements the later wins and a tie goes to the larger name, in either order', () => {
    const a = { name: 'Alpha', at: T, statement: true as const };
    const z = { name: 'Zeta', at: T, statement: true as const };
    const later = { name: 'Alpha', at: T + 1, statement: true as const };
    const fold = (...s: Array<typeof a>) =>
      s.reduce((row, next) => {
        const out = withDatedGroupName(row, next);
        return 'row' in out ? out.row : row;
      }, group());
    expect(fold(a, z).name).toBe('Zeta');
    expect(fold(z, a).name).toBe('Zeta');
    expect(fold(z, later).name).toBe('Alpha');
    expect(fold(later, z).name).toBe('Alpha');
  });

  it('the row carries the rank with the date, and a rename removes it', () => {
    const stated = rowOf(withDatedGroupName(group(), { name: 'Groupe', at: T, statement: true }));
    expect(stated).toMatchObject({ name: 'Groupe', nameAt: T, nameFromStatement: true });
    const renamed = rowOf(applyRenameFrame(stated, 'Nouveau', T - 1_000, T - 1_000, 'bob'));
    expect(renamed.nameFromStatement).toBeUndefined();
    expect(renamed).toMatchObject({ name: 'Nouveau', nameAt: T - 1_000 });
  });

  it('a statement is bounded by its signed sentAt exactly as a rename is', () => {
    expect(applyNameStatement(group(), 'Groupe', Date.UTC(2100, 0, 1), T)).toEqual({
      refused: 'server-time-out-of-bound',
    });
    expect(applyNameStatement(group(), 'Groupe', T, undefined)).toEqual({
      refused: 'no-signed-time',
    });
  });

  it("an own rename answered with no server time drops the statement's rank with its date", () => {
    const stated = group({ name: 'Groupe', nameAt: T, nameFromStatement: true });
    const out = rowOf(
      ownRenameOutcome(stated, 'Nouveau', null, false, { name: 'Groupe', at: T }, 'me')
    );
    expect(out.nameAt).toBeUndefined();
    expect(out.nameFromStatement).toBeUndefined();
  });

  it('the join push carries the rank: a newcomer holds a statement as a statement', () => {
    const relayed = restatedGroupName({ name: 'Groupe', nameAt: T, nameFromStatement: true });
    expect(relayed).toEqual({ name: 'Groupe', at: T, statement: true });
    const read = boundedRestatedGroupName(relayed, T + 1_000);
    expect(read).toEqual({ kept: { name: 'Groupe', at: T, statement: true } });
    // An inviter of the step-1 build relays no rank: its dates came from renames only.
    expect(boundedRestatedGroupName({ name: 'Groupe', at: T }, T + 1_000)).toEqual({
      kept: { name: 'Groupe', at: T },
    });
  });
});

describe('when the sweep states a name, read off the row (nameStatementDue)', () => {
  const OWN = { name: 'Groupe', messageId: 'm-1', sentAt: T };

  it('an undated group named as the list names it: a fresh statement', () => {
    expect(nameStatementDue(group(), 'Groupe')).toEqual({ due: 'mint' });
  });

  it('a dated row is never stated again - the date is the durable "once"', () => {
    expect(nameStatementDue(group({ nameAt: T }), 'Groupe')).toEqual({ not: 'dated' });
    expect(nameStatementDue(group({ nameAt: T, nameFromStatement: true }), 'Groupe')).toEqual({
      not: 'dated',
    });
  });

  it('an unanswered statement of this name is re-sent; an answered one never again', () => {
    expect(nameStatementDue(group({ nameSync: { statement: OWN } }), 'Groupe')).toEqual({
      due: 'resend',
      statement: OWN,
    });
    expect(
      nameStatementDue(group({ nameSync: { statement: { ...OWN, answered: true } } }), 'Groupe')
    ).toEqual({ not: 'answered' });
  });

  it("a name the server's list does not hold, an empty one, a DM, a pending row: nothing", () => {
    expect(nameStatementDue(group({ name: 'g1' }), '')).toEqual({ not: 'unnamed' });
    expect(nameStatementDue(group({ name: '' }), '')).toEqual({ not: 'unnamed' });
    expect(nameStatementDue(group({ name: 'Guess' }), 'Groupe')).toEqual({ not: 'unnamed' });
    expect(nameStatementDue(group({ conversationType: 'direct' }), 'Groupe')).toEqual({
      not: 'not-a-group',
    });
    expect(nameStatementDue(group({ lifecycle: 'pending' }), 'Groupe')).toEqual({
      not: 'not-active',
    });
  });

  it("a rename of this device's own still owed blocks it; an unconfirmed one does not", () => {
    const pending = { name: 'N', messageId: 'p', sentAt: T, over: { name: 'Groupe' } };
    expect(nameStatementDue(group({ nameSync: { pending } }), 'Groupe')).toEqual({
      not: 'rename-owed',
    });
    expect(
      nameStatementDue(group({ nameSync: { serverCopy: { name: 'Groupe', from: 'O' } } }), 'Groupe')
    ).toEqual({ not: 'rename-owed' });
    expect(nameStatementDue(group({ nameSync: { unconfirmed: pending } }), 'Groupe')).toEqual({
      due: 'mint',
    });
  });
});

describe("what this device's own statement does to its row (ownNameStatementOutcome)", () => {
  const MINTED = { name: 'Groupe', messageId: 'm-1', sentAt: T };

  it('answered with a time: dated at a statement rank, nothing recorded', () => {
    const out = ownNameStatementOutcome(group({ nameSync: { statement: MINTED } }), MINTED, {
      sent: { receivedAt: T + 5 },
    });
    expect(out).toMatchObject({ nameAt: T + 5, nameFromStatement: true });
    expect(out!.nameSync).toBeUndefined();
  });

  it('a rename read while it was in flight stays', () => {
    const renamed = group({ name: 'Nouveau', nameAt: T - 1_000 });
    const out = ownNameStatementOutcome(renamed, MINTED, { sent: { receivedAt: T + 5 } });
    expect(out).toMatchObject({ name: 'Nouveau', nameAt: T - 1_000 });
    expect(out!.nameFromStatement).toBeUndefined();
  });

  it('answered with none: recorded answered; no answer: recorded to re-send; refused: dropped', () => {
    expect(
      ownNameStatementOutcome(group(), MINTED, { sent: { receivedAt: null } })!.nameSync
    ).toEqual({ statement: { ...MINTED, answered: true } });
    expect(ownNameStatementOutcome(group(), MINTED, { kept: 'unanswered' })!.nameSync).toEqual({
      statement: MINTED,
    });
    expect(
      ownNameStatementOutcome(group({ nameSync: { statement: MINTED } }), MINTED, {
        refused: 'clock',
      })!.nameSync
    ).toBeUndefined();
    expect(ownNameStatementOutcome(group(), MINTED, { kept: 'not-sent' })).toBeNull();
  });

  it('the record survives the store: parseNameSync reads it back, and refuses a bad one', () => {
    const stored = JSON.stringify({ statement: { ...MINTED, answered: true } });
    expect(parseNameSync(stored)).toEqual({ statement: { ...MINTED, answered: true } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseNameSync(JSON.stringify({ statement: { name: 'x' } }))).toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('#3888 review: statements and the rest of the rule', () => {
  const PENDING = { name: 'New', messageId: 'p-1', sentAt: T, over: { name: 'Old', at: T - 1 } };

  it('B1: a row a statement dated never supersedes a pending rename, whatever its name or date', () => {
    for (const held of [
      { name: 'Old', nameAt: T + 5, nameFromStatement: true as const },
      { name: 'Other', nameAt: T + 9, nameFromStatement: true as const },
      { name: 'New', nameAt: T + 9, nameFromStatement: true as const },
    ]) {
      expect(pendingRenameVerdict(held, PENDING)).toBe('resend');
    }
    // A RENAME dated after the base still supersedes it, as before.
    expect(pendingRenameVerdict({ name: 'Old', nameAt: T + 5 }, PENDING)).toBe('superseded');
  });

  it('S1/A2: only the AUTHOR of the rename held answers a statement of ANOTHER name, never an answer', () => {
    const renamed = group({ name: 'Nouveau', nameAt: T, nameRenamedBy: 'alice' });
    const s1 = { id: 's-1', isAnswer: false };
    expect(statementAnswerDue(renamed, 'Ancien', s1, 'alice')).toBe(true);
    expect(statementAnswerDue(renamed, 'Ancien', s1, 'ALICE')).toBe(true);
    // Another member's device holds the same rename: it does not answer (A2).
    expect(statementAnswerDue(renamed, 'Ancien', s1, 'bob')).toBe(false);
    // A rename whose author is not known (dated before this build): nobody answers.
    expect(statementAnswerDue(group({ name: 'Nouveau', nameAt: T }), 'Ancien', s1, 'alice')).toBe(
      false
    );
    expect(statementAnswerDue(renamed, 'Nouveau', s1, 'alice')).toBe(false);
    expect(statementAnswerDue(renamed, 'Ancien', { id: 's-2', isAnswer: true }, 'alice')).toBe(
      false
    );
    // A statement-dated row never answers: that is what terminates it.
    expect(
      statementAnswerDue(group({ nameAt: T, nameFromStatement: true }), 'Ancien', s1, 'alice')
    ).toBe(false);
  });

  it('A1: the answer is OWED until a send settles it; one owed answer at a time', () => {
    const renamed = group({ name: 'Nouveau', nameAt: T, nameRenamedBy: 'alice' });
    const owed = withOwedAnswer(renamed, 's-1');
    expect(owed.nameSync).toEqual({ answer: { to: 's-1' } });
    // Owed: no second answer is due, to this statement or another (one answer heals them all).
    expect(statementAnswerDue(owed, 'Ancien', { id: 's-1', isAnswer: false }, 'alice')).toBe(false);
    expect(statementAnswerDue(owed, 'Autre', { id: 's-2', isAnswer: false }, 'alice')).toBe(false);
    expect(owedAnswerDue(owed, 'alice')).toEqual({ due: 'mint', to: 's-1' });
    const frame = { name: 'Nouveau', renameAt: T, messageId: 'a-1', sentAt: T + 50 };
    // No answer: the SAME frame is re-sent.
    const kept = ownAnswerOutcome(owed, 's-1', frame, { kept: 'unanswered' });
    expect(owedAnswerDue(kept, 'alice')).toEqual({ due: 'resend', frame, to: 's-1' });
    // A frame minted for another name is not re-sent: the row moved on, a fresh one goes out.
    expect(owedAnswerDue({ ...kept, name: 'Troisieme', nameAt: T + 9 }, 'alice')).toEqual({
      due: 'mint',
      to: 's-1',
    });
    // Sent: settled, and the statement's re-delivery is not answered again - a new one is.
    const sent = ownAnswerOutcome(kept, 's-1', frame, { sent: { receivedAt: T + 60 } });
    expect(sent.nameSync).toEqual({ answer: { to: 's-1', done: true } });
    expect(owedAnswerDue(sent, 'alice')).toBe('none');
    expect(statementAnswerDue(sent, 'Ancien', { id: 's-1', isAnswer: false }, 'alice')).toBe(false);
    expect(statementAnswerDue(sent, 'Ancien', { id: 's-3', isAnswer: false }, 'alice')).toBe(true);
    // The clock refused: the frame dropped, the debt kept.
    expect(ownAnswerOutcome(kept, 's-1', frame, { refused: 'clock' }).nameSync).toEqual({
      answer: { to: 's-1' },
    });
    // A later rename by someone else voids it.
    expect(owedAnswerDue({ ...owed, nameRenamedBy: 'bob', nameAt: T + 9 }, 'alice')).toBe('void');
  });

  it('A2: an answer read that says what this device owes settles it unsent', () => {
    const owed = withOwedAnswer(
      group({ name: 'Nouveau', nameAt: T, nameRenamedBy: 'alice' }),
      's-1'
    );
    expect(answerReadSettlesOwn(owed, { name: 'Nouveau', renameAt: T })!.nameSync).toEqual({
      answer: { to: 's-1', done: true },
    });
    expect(answerReadSettlesOwn(owed, { name: 'Nouveau', renameAt: T - 1 })).toBeNull();
    expect(answerReadSettlesOwn(owed, { name: 'Autre', renameAt: T })).toBeNull();
  });

  it('the owed answer survives the store, frame included', () => {
    const answer = {
      to: 's-1',
      frame: { name: 'Nouveau', renameAt: T, messageId: 'a-1', sentAt: T + 50 },
    };
    expect(parseNameSync(JSON.stringify({ answer }))).toEqual({ answer });
    expect(parseNameSync(JSON.stringify({ answer: { to: 's-1', done: true } }))).toEqual({
      answer: { to: 's-1', done: true },
    });
  });
});

describe('#3888 re-review A3: answers are ordered by the rename they restate', () => {
  const plain = (name: string, at: number) =>
    rowOf(applyNameStatement(group({ name: 'Groupe' }), name, at, at));

  it('an answer beats a plain statement whatever the dates', () => {
    const stated = plain('Ancien', T + 100);
    const answered = applyNameStatement(stated, 'Nouveau', T + 50, T + 50, { renameAt: T });
    expect(rowOf(answered)).toMatchObject({ name: 'Nouveau', nameAt: T + 50, nameRenameAt: T });
    // ...and a later plain statement never takes it back.
    expect(applyNameStatement(rowOf(answered), 'Ancien', T + 200, T + 200)).toEqual({
      skipped: 'not-newer',
    });
  });

  it('two answers converge on the NEWER rename, in both reading orders', () => {
    const base = plain('Ancien', T + 100);
    // The older rename's answer was SENT later: ordered by its rename, it still loses.
    const older = { name: 'Vieux', at: T + 300, renameAt: T + 10 };
    const newer = { name: 'Neuf', at: T + 200, renameAt: T + 20 };
    const read = (first: typeof older, second: typeof older) => {
      const a = rowOf(applyNameStatement(base, first.name, first.at, first.at, first));
      const b = applyNameStatement(a, second.name, second.at, second.at, second);
      return 'row' in b ? b.row : a;
    };
    expect(read(older, newer).name).toBe('Neuf');
    expect(read(newer, older).name).toBe('Neuf');
  });

  it("an answer's rename date is bounded by its own server time, and a rename still beats it", () => {
    expect(applyNameStatement(group(), 'Nouveau', T, T, { renameAt: T + 1 })).toEqual({
      refused: 'unbounded-rename-time',
    });
    expect(applyNameStatement(group(), 'Nouveau', T, T, { renameAt: undefined })).toEqual({
      refused: 'unbounded-rename-time',
    });
    const answered = rowOf(applyNameStatement(group(), 'Nouveau', T, T, { renameAt: T - 5 }));
    expect(rowOf(applyRenameFrame(answered, 'Rename', T - 100, T - 100, 'bob'))).toMatchObject({
      name: 'Rename',
      nameRenamedBy: 'bob',
    });
  });

  it("the join push carries the answer's rename date and the rename's author", () => {
    const answered = group({ name: 'N', nameAt: T, nameFromStatement: true, nameRenameAt: T - 5 });
    const pushed = restatedGroupName(answered)!;
    expect(pushed).toEqual({ name: 'N', at: T, statement: true, renameAt: T - 5 });
    expect(boundedRestatedGroupName(pushed, T + 1)).toEqual({ kept: pushed });
    const renamed = restatedGroupName(group({ name: 'N', nameAt: T, nameRenamedBy: 'alice' }))!;
    expect(boundedRestatedGroupName(renamed, T + 1)).toEqual({
      kept: { name: 'N', at: T, by: 'alice' },
    });
  });
});
