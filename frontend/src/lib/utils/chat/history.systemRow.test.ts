import type { StoredMessage } from '$lib/db/types';
import { toMessagePayload } from '$lib/db/messagePayload';
import { SYSTEM_SENDER_ID, isSystemSender } from './messageUtils';
import { mapStoredMessagesToChatMessages } from './history';

/**
 * ONE BELIEF, ONE DERIVATION - the invariant a duplicated group notice came from.
 *
 * `ChatMessage.isSystem` is what the renderer reads, and `StoredMessage` has no column for it: a row
 * read back from IndexedDB, or copied out of a peer's `history_bundle`, is recognised by its SENDER
 * and by nothing else. Every writer that set the flag without the id, or carried the id without
 * setting the flag, produced a notice rendered as an ORDINARY BUBBLE labelled "Utilisateur" - the
 * unknown-user string, because no display name resolves for the sentinel.
 *
 * These cases pin the two halves that make the derivation sound: the sentinel SURVIVES into the
 * encrypted payload a bundle is built from, and the read path derives the flag from it rather than
 * expecting somebody upstream to have remembered.
 */

function stored(over: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'm1',
    conversationId: 'g1',
    senderId: 'user-b',
    content: 'hello',
    timestamp: 1_700_000_000_000,
    ...over,
  };
}

describe('a system row is recognised by its sender', () => {
  it('flags a stored row carrying the sentinel', () => {
    const [row] = mapStoredMessagesToChatMessages(
      [stored({ senderId: SYSTEM_SENDER_ID })],
      'user-a'
    );

    expect(row.isSystem).toBe(true);
    // And it is never somebody's own message, whoever is reading it.
    expect(row.isOwn).toBe(false);
  });

  it('flags it whatever case the sender was written in', () => {
    const [row] = mapStoredMessagesToChatMessages([stored({ senderId: 'System' })], 'user-a');

    expect(row.isSystem).toBe(true);
  });

  // The negative half: an ordinary author must not be turned into a centred pill.
  it('leaves an ordinary sender alone', () => {
    const [row] = mapStoredMessagesToChatMessages([stored({ senderId: 'user-b' })], 'user-a');

    expect(row.isSystem).toBe(false);
  });

  // WHY THE DERIVATION IS AVAILABLE AT ALL. The bundle's rows are built from this payload, which
  // carries the sender and has no room for a UI flag - so a receiver that waited to be TOLD a row
  // was a notice was waiting for something the wire never sends.
  it('carries the sentinel into the payload a bundle is built from', () => {
    const payload = toMessagePayload(stored({ senderId: SYSTEM_SENDER_ID }));

    expect(payload.senderId).toBe(SYSTEM_SENDER_ID);
    expect(payload.isSystem).toBeUndefined();
  });

  it('and the predicate is the single spelling of that fact', () => {
    expect(isSystemSender(SYSTEM_SENDER_ID)).toBe(true);
    expect(isSystemSender('SYSTEM')).toBe(true);
    expect(isSystemSender('system-user')).toBe(false);
    expect(isSystemSender('')).toBe(false);
  });
});
