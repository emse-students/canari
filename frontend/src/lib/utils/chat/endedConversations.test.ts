import { describe, expect, it } from 'vitest';
import { endedConversationIds, watchEndings, snapshotConversations } from './endedConversations';

const snap = (...rows: [string, string?][]) =>
  snapshotConversations(rows.map(([id, lifecycle]) => ({ id, lifecycle })));

describe('endedConversationIds', () => {
  it('a deleted row ended', () => {
    expect(endedConversationIds(snap(['g1'], ['g2']), snap(['g2']))).toEqual(['g1']);
  });

  it('a row turned removed (deleted by a peer, excluded) ended', () => {
    expect(endedConversationIds(snap(['g1', 'active']), snap(['g1', 'removed']))).toEqual(['g1']);
  });

  it('a pending conversation that turns removed ended too', () => {
    expect(endedConversationIds(snap(['g1', 'pending']), snap(['g1', 'removed']))).toEqual(['g1']);
  });

  it('a conversation moved to another key keeps its id and did not end', () => {
    // The snapshot is by id: a re-key changes the map key, not the id.
    expect(endedConversationIds(snap(['g1']), snap(['g1']))).toEqual([]);
  });

  it('an already removed conversation that then disappears is not an ending again', () => {
    expect(endedConversationIds(snap(['g1', 'removed']), snap())).toEqual([]);
  });

  it('a conversation first seen now, or still active, ended nothing', () => {
    expect(endedConversationIds(snap(['g1']), snap(['g1'], ['g2']))).toEqual([]);
  });

  it('a row with no lifecycle reads as active', () => {
    expect(endedConversationIds(snap(['g1']), snap())).toEqual(['g1']);
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
});
