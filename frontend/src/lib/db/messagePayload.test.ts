import type { StoredMessage } from './types';
import { fromMessagePayload, mergeStoredMessage, toMessagePayload } from './messagePayload';

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
      reactions: [{ emoji: '👍', userId: 'bob' }],
      serverTimestamp: 1_700_000_002_000,
      isDeleted: true,
      isEdited: true,
      editedAt: 1_700_000_003_000,
    });

    expect(full).toMatchObject({
      reactions: [{ emoji: '👍', userId: 'bob' }],
      serverTimestamp: 1_700_000_002_000,
      isDeleted: true,
      isEdited: true,
      editedAt: 1_700_000_003_000,
    });
  });

  it('omits empty optionals rather than storing them', () => {
    const payload = toMessagePayload({ ...BASE, reactions: [], editedAt: 0 });

    expect(Object.keys(payload).sort()).toEqual(['content', 'senderId']);
  });

  it('normalises the sender id and rejects malformed numbers', () => {
    expect(toMessagePayload({ ...BASE, senderId: '  ALICE ' }).senderId).toBe('alice');

    const hostile = fromMessagePayload(KEYS, {
      senderId: 'alice',
      content: 'x',
      editedAt: -1,
      isEdited: 'yes',
    });
    expect(hostile.editedAt).toBeUndefined();
    expect(hostile.isEdited).toBeUndefined();
  });
});

describe('merging a mutation onto a stored message', () => {
  /**
   * Every mutation handler used to rebuild the whole row from what it happened to know, and
   * `saveMessage` is a full-row replace - so the row's contents depended on which mutation touched
   * it last. The two cases below are the ones confirmed by hand (D1).
   */
  it('keeps the tombstone when a reaction lands on a deleted message', () => {
    const stored: StoredMessage = { ...BASE, isDeleted: true, content: 'deleted' };

    const merged = mergeStoredMessage(stored, { reactions: [{ emoji: '👍', userId: 'bob' }] });

    expect(merged.isDeleted).toBe(true);
    expect(merged.content).toBe('deleted');
    expect(merged.reactions).toEqual([{ emoji: '👍', userId: 'bob' }]);
  });

  it('keeps the edit flags when a later mutation lands on an edited message', () => {
    const stored: StoredMessage = { ...BASE, isEdited: true, editedAt: 1_700_000_042_000 };

    const merged = mergeStoredMessage(stored, { reactions: [{ emoji: '👍', userId: 'bob' }] });

    expect(merged.isEdited).toBe(true);
    expect(merged.editedAt).toBe(1_700_000_042_000);
    expect(merged.reactions).toEqual([{ emoji: '👍', userId: 'bob' }]);
  });

  it('leaves a field alone when the patch carries it as undefined', () => {
    // Handlers build patches with spread and optionals, so an absent value arrives as `undefined`
    // rather than as a missing key. It must read as "I know nothing about this field".
    const stored: StoredMessage = { ...BASE, serverTimestamp: 1_700_000_002_000 };

    const merged = mergeStoredMessage(stored, { serverTimestamp: undefined, isEdited: true });

    expect(merged.serverTimestamp).toBe(1_700_000_002_000);
  });

  it('clears a field when the patch says so explicitly', () => {
    // Removing the last reaction empties the list. Clearing has to stay expressible, or the merge
    // would make some mutations impossible.
    const stored: StoredMessage = { ...BASE, reactions: [{ emoji: '👍', userId: 'bob' }] };

    const merged = mergeStoredMessage(stored, { reactions: [] });

    expect(merged.reactions).toEqual([]);
    // And an empty list is stored as no list at all, which is how a removal becomes durable.
    expect(Object.keys(toMessagePayload(merged)).sort()).toEqual(['content', 'senderId']);
  });

  it('never lets a patch move a message to another conversation', () => {
    // The type forbids it, but the guarantee is enforced here too: the patch API is keyed by id,
    // so a row that changed conversation would vanish from both.
    const rogue = { content: 'edited', id: 'other-msg', conversationId: 'other-conv' };
    const merged = mergeStoredMessage(BASE, rogue as Parameters<typeof mergeStoredMessage>[1]);

    expect(merged.id).toBe(BASE.id);
    expect(merged.conversationId).toBe(BASE.conversationId);
    expect(merged.content).toBe('edited');
  });
});
