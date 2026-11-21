import { describe, expect, it } from 'vitest';
import { endedConversationIds, snapshotConversations } from './endedConversations';

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
