import { describe, expect, it } from 'vitest';
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
  it("a peer's later rename applied during the send stays", () => {
    const meanwhile = group({ name: 'B', nameAt: T + 5_000 });
    expect(ownRenameOutcome(meanwhile, 'A', T)).toEqual({ skipped: 'not-newer' });
  });

  it('dated by the answer when newer', () => {
    expect(rowOf(ownRenameOutcome(group({ nameAt: T }), 'A', T + 1))).toMatchObject({
      name: 'A',
      nameAt: T + 1,
    });
  });

  it('with no server time in the answer the row is written undated, never under an older date', () => {
    const row = rowOf(ownRenameOutcome(group({ name: 'Old', nameAt: T }), 'A', null));
    expect(row.name).toBe('A');
    expect('nameAt' in row).toBe(false);
  });
});
