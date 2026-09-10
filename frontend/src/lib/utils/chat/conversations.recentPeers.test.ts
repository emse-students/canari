/**
 * THE LIST THAT REPLACES 600px OF NOTHING.
 *
 * "Nouvelle discussion" opened on a search field with no list behind it, so the panel drew its
 * controls in the top ~230px and left the rest blank (observed on the Mi 9T, 2026-09-09). What goes
 * there is the people already in the sidebar - and the three ways that list can be wrong are the
 * three pinned here: a group offered as a person, one person listed twice after a reload, and a row
 * whose name never resolved offered as "unknown user".
 */
import { describe, it, expect } from 'vitest';
import { recentDirectPeers } from './conversations';

function row(
  contactId: string,
  displayName: string,
  lastMessageAt: number | null,
  extra: { type?: 'direct' | 'group'; resolvedName?: boolean } = {}
) {
  return {
    resolved: {
      conversationType: extra.type ?? ('direct' as const),
      contactId,
      displayName,
      displayNameResolved: extra.resolvedName ?? true,
    },
    lastMessageAt,
  };
}

describe('recentDirectPeers', () => {
  it('orders by the last message, most recent first', () => {
    const peers = recentDirectPeers([
      row('older', 'Alice', 1000),
      row('newest', 'Bob', 3000),
      row('middle', 'Chloe', 2000),
    ]);

    expect(peers.map((p) => p.peerId)).toEqual(['newest', 'middle', 'older']);
  });

  it('offers only people, never a group', () => {
    // A group has no peer to start a DM with, and this tab's action is "start a conversation with".
    const peers = recentDirectPeers([
      row('g1', 'Les BDE', 5000, { type: 'group' }),
      row('u1', 'Alice', 1000),
    ]);

    expect(peers.map((p) => p.displayName)).toEqual(['Alice']);
  });

  it('lists one person once, keeping the most recent record', () => {
    // One peer legitimately holds several conversation records after an MLS reload. Two rows for
    // the same human is the kind of thing a reader reads as a bug in the list.
    const peers = recentDirectPeers([
      row('u1', 'Alice (stale label)', 1000),
      row('u1', 'Alice', 4000),
      row('u2', 'Bob', 2000),
    ]);

    expect(peers).toEqual([
      { peerId: 'u1', displayName: 'Alice' },
      { peerId: 'u2', displayName: 'Bob' },
    ]);
  });

  it('drops a row whose name has not resolved rather than offering "unknown user"', () => {
    // The whole point of the list is recognition; a placeholder is the one entry nobody can act on.
    const peers = recentDirectPeers([
      row('cold', 'Utilisateur inconnu', 9000, { resolvedName: false }),
      row('warm', 'Alice', 1000),
    ]);

    expect(peers.map((p) => p.peerId)).toEqual(['warm']);
  });

  it('treats a conversation with no message yet as the oldest rather than dropping it', () => {
    // It is still someone this account has a thread with, so it belongs on the list - last.
    const peers = recentDirectPeers([row('fresh', 'Alice', null), row('busy', 'Bob', 500)]);

    expect(peers.map((p) => p.peerId)).toEqual(['busy', 'fresh']);
  });

  it('caps the list, because a picker that scrolls before you type is the same problem again', () => {
    const many = Array.from({ length: 20 }, (_, i) => row(`u${i}`, `Person ${i}`, i));

    expect(recentDirectPeers(many)).toHaveLength(8);
    expect(recentDirectPeers(many, 3).map((p) => p.peerId)).toEqual(['u19', 'u18', 'u17']);
  });

  it('is empty for an account with no conversations, which is the only blank state left', () => {
    expect(recentDirectPeers([])).toEqual([]);
  });
});
