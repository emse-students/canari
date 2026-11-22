import { describe, expect, it } from 'vitest';
import {
  confirmEnding,
  endedConversationIds,
  recordRekey,
  snapshotConversations,
  currentEndingFacts,
  settleEndingFacts,
  watchEndings,
} from './endedConversations';

const snap = (...rows: [string, string?][]) =>
  snapshotConversations(rows.map(([id, lifecycle]) => ({ id, lifecycle })));

describe('endedConversationIds', () => {
  it('a deleted row ended', () => {
    expect(endedConversationIds(snap(['g1'], ['g2']), snap(['g2']))).toEqual(['g1']);
  });

  const confirmed = (...ids: string[]) => ({ rekeyed: new Set<string>(), confirmed: new Set(ids) });

  it('a row turned removed on CONFIRMED evidence (a Remove commit, a deletion) ended', () => {
    expect(
      endedConversationIds(snap(['g1', 'active']), snap(['g1', 'removed']), confirmed('g1'))
    ).toEqual(['g1']);
  });

  it('a pending conversation that turns removed on confirmed evidence ended too', () => {
    expect(
      endedConversationIds(snap(['g1', 'pending']), snap(['g1', 'removed']), confirmed('g1'))
    ).toEqual(['g1']);
  });

  it('a row turned removed by a MISS keeps its banners: a Welcome may re-admit it', () => {
    expect(endedConversationIds(snap(['g1', 'active']), snap(['g1', 'removed']))).toEqual([]);
    // ...and the re-admission that follows ends nothing either.
    expect(endedConversationIds(snap(['g1', 'removed']), snap(['g1', 'active']))).toEqual([]);
  });

  it('a re-keyed row (its id replaced by the joined group) did not end: its thread continues', () => {
    const facts = { rekeyed: new Set(['old']), confirmed: new Set<string>() };
    expect(endedConversationIds(snap(['old']), snap(['new']), facts)).toEqual([]);
    // Without the fact the vanished id is an ending, as for any deleted row.
    expect(endedConversationIds(snap(['old']), snap(['new']))).toEqual(['old']);
  });

  it('only the re-keyed id is spared, not another one that vanished in the same look', () => {
    const facts = { rekeyed: new Set(['old']), confirmed: new Set<string>() };
    expect(endedConversationIds(snap(['old'], ['gone']), snap(['new']), facts)).toEqual(['gone']);
  });

  it('a conversation moved to another key keeps its id and did not end', () => {
    // The snapshot is by id: a re-key changes the map key, not the id.
    expect(endedConversationIds(snap(['g1']), snap(['g1']))).toEqual([]);
  });

  it('an unconfirmed removed row that is then purged ends: its banners were never taken down', () => {
    expect(endedConversationIds(snap(['g1', 'removed']), snap())).toEqual(['g1']);
  });

  it('an id the watcher already ended is not ended again, purged or not', () => {
    expect(endedConversationIds(snap(['g1', 'ended']), snap())).toEqual([]);
  });

  it('a conversation first seen now, or still active, ended nothing', () => {
    expect(endedConversationIds(snap(['g1']), snap(['g1'], ['g2']))).toEqual([]);
  });

  it('a row with no lifecycle reads as active', () => {
    expect(endedConversationIds(snap(['g1']), snap())).toEqual(['g1']);
  });
});

describe('ending facts', () => {
  const drain = () => settleEndingFacts(false, new Map());

  it('a re-key survives looks until its old id leaves the map; a confirmation is dropped once used', () => {
    drain();
    recordRekey('old');
    confirmEnding('g1');
    // The boot merge records the re-key long before the loser leaves the map: still there.
    settleEndingFacts(true, snap(['old'], ['g1', 'removed']));
    expect([...currentEndingFacts().rekeyed]).toEqual(['old']);
    // g1 was removed in that look: the confirmation was used.
    expect(currentEndingFacts().confirmed.size).toBe(0);
    settleEndingFacts(true, snap(['new']));
    expect(currentEndingFacts().rekeyed.size).toBe(0);
  });

  it('a confirmation seen on an ACTIVE row is stale and dropped, so it cannot end a later miss', () => {
    drain();
    confirmEnding('g1');
    settleEndingFacts(true, snap(['g1', 'active']));
    expect(currentEndingFacts().confirmed.size).toBe(0);
  });

  it('all facts are dropped at sign-out', () => {
    recordRekey('o2');
    confirmEnding('g2');
    drain();
    expect(currentEndingFacts().rekeyed.size).toBe(0);
    expect(currentEndingFacts().confirmed.size).toBe(0);
  });
});

describe('watchEndings', () => {
  it('ends a row that is gone while signed in', () => {
    expect(watchEndings(true, snap(['g1'], ['g2']), snap(['g2'])).ended).toEqual(['g1']);
  });

  it('ends nothing while signed out - a lost session clears the map, no conversation ended', () => {
    const lost = watchEndings(false, snap(['g1'], ['g2']), snap());
    expect(lost.ended).toEqual([]);
    expect(lost.known.size).toBe(0);
    // The sign-in that follows restores the list: a first look, so nothing is compared to the old one.
    expect(watchEndings(true, lost.known, snap(['g1'])).ended).toEqual([]);
  });

  it('an unconfirmed removal, then a confirmation, ends the banners (once)', () => {
    const first = watchEndings(true, snap(['g1']), snap(['g1', 'removed']));
    expect(first.ended).toEqual([]);
    const facts = { rekeyed: new Set<string>(), confirmed: new Set(['g1']) };
    const second = watchEndings(true, first.known, snap(['g1', 'removed']), facts);
    expect(second.ended).toEqual(['g1']);
    // Remembered as ended while the row stays removed: a third look, or the purge, ends nothing more.
    expect(watchEndings(true, second.known, snap(['g1', 'removed']), facts).ended).toEqual([]);
    expect(watchEndings(true, second.known, snap()).ended).toEqual([]);
  });

  it('an unconfirmed removal that is then purged ends the banners', () => {
    const first = watchEndings(true, snap(['g1']), snap(['g1', 'removed']));
    expect(watchEndings(true, first.known, snap()).ended).toEqual(['g1']);
  });

  it('a false removal followed by a re-admission ends nothing, then a real ending still does', () => {
    const removed = watchEndings(true, snap(['g1']), snap(['g1', 'removed']));
    const readmitted = watchEndings(true, removed.known, snap(['g1', 'active']));
    expect(readmitted.ended).toEqual([]);
    expect(watchEndings(true, readmitted.known, snap()).ended).toEqual(['g1']);
  });
});
