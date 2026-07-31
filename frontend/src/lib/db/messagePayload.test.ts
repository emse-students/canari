import type { StoredMessage } from './types';
import { fromMessagePayload, toMessagePayload } from './messagePayload';

const KEYS = { id: 'msg-1', conversationId: 'conv-1', timestamp: 1_700_000_000_000 };

/** Encode then decode, the way both storage backends do around encryptData/decryptData. */
function roundTrip(msg: StoredMessage): StoredMessage {
  return fromMessagePayload(KEYS, toMessagePayload(msg));
}

const BASE: StoredMessage = {
  ...KEYS,
  senderId: 'alice',
  content: '{"type":"text","body":"hello"}',
};

describe('message payload round trip', () => {
  it('keeps the edited body AND the edit time', () => {
    // Regression (WP-EDIT-1): the sender's own edit is never echoed back over MLS, so this round
    // trip is the only thing that makes it survive a reload. `editedAt` existed on ChatMessage but
    // on neither the stored payload nor StoredMessage, so the edit time was dropped on every load.
    const edited = roundTrip({
      ...BASE,
      content: 'corrected body',
      isEdited: true,
      editedAt: 1_700_000_042_000,
    });

    expect(edited.content).toBe('corrected body');
    expect(edited.isEdited).toBe(true);
    expect(edited.editedAt).toBe(1_700_000_042_000);
  });

  it('reads a row written before editedAt existed', () => {
    // The previous at-rest format: isEdited with no companion timestamp. It must still load, and
    // still render the "edited" marker - only the time is unknown.
    const legacy = fromMessagePayload(KEYS, {
      senderId: 'alice',
      content: 'corrected body',
      isEdited: true,
    });

    expect(legacy.isEdited).toBe(true);
    expect(legacy.editedAt).toBeUndefined();
  });

  it('round-trips every optional field a mutation can set', () => {
    const full = roundTrip({
      ...BASE,
      readBy: ['bob'],
      reactions: [{ emoji: '👍', userId: 'bob' }],
      readAt: 1_700_000_001_000,
      serverTimestamp: 1_700_000_002_000,
      isDeleted: true,
      isEdited: true,
      editedAt: 1_700_000_003_000,
    });

    expect(full).toMatchObject({
      readBy: ['bob'],
      reactions: [{ emoji: '👍', userId: 'bob' }],
      readAt: 1_700_000_001_000,
      serverTimestamp: 1_700_000_002_000,
      isDeleted: true,
      isEdited: true,
      editedAt: 1_700_000_003_000,
    });
  });

  it('omits empty optionals rather than storing them', () => {
    const payload = toMessagePayload({ ...BASE, readBy: [], reactions: [], editedAt: 0 });

    expect(Object.keys(payload).sort()).toEqual(['content', 'senderId']);
  });

  it('normalises the sender id and rejects malformed numbers', () => {
    expect(toMessagePayload({ ...BASE, senderId: '  ALICE ' }).senderId).toBe('alice');

    const hostile = fromMessagePayload(KEYS, {
      senderId: 'alice',
      content: 'x',
      readAt: '1700000000000',
      editedAt: -1,
      readBy: 'bob',
      isEdited: 'yes',
    });
    expect(hostile.readAt).toBeUndefined();
    expect(hostile.editedAt).toBeUndefined();
    expect(hostile.readBy).toBeUndefined();
    expect(hostile.isEdited).toBeUndefined();
  });
});
