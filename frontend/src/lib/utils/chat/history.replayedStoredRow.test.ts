import { describe, expect, it } from 'vitest';
import { provenRowsIntoMemory, replayedStoredRow } from './history';
import type { ChatMessage } from '$lib/types';
import type { StoredMessage } from '$lib/db';
import type { RecordedAuthorship } from '$lib/crypto/messageAuthorship';
import { chat_system_message_deleted } from '$lib/paraglide/messages';
import { envelopeBodyText } from '$lib/envelope';

/**
 * The row a replay page writes for one queued message, against the row this device already stores.
 * A replay can re-read what an earlier run wrote, so the stored proofs and the stored verdict are
 * evidence it must not lose: a proof is kept when the incoming copy carries none for the same state,
 * and a row is never DOWNGRADED from proven to "non verifie".
 */
const PROOF = (tag: string): RecordedAuthorship => ({ body: tag, proof: tag, group: 'g' });
const at = { id: 'm1', conversationId: 'c1', userId: 'me' };

function stored(extra: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    senderId: 'alice',
    content: 'hello',
    timestamp: 1,
    ...extra,
  };
}

describe('replayedStoredRow', () => {
  it('keeps the stored tombstone proof when the incoming deleted copy carries none', () => {
    const prev = stored({ isDeleted: true, content: 'x', deleteProof: PROOF('del') });
    const row = replayedStoredRow({ senderId: 'alice', content: 'x', isDeleted: true }, prev, at);
    expect(row.isDeleted).toBe(true);
    expect(row.content).toBe(chat_system_message_deleted());
    expect(row.deleteProof).toEqual(PROOF('del'));
  });

  it('keeps the stored authorship and edit proof when the incoming copy carries none', () => {
    const prev = stored({
      authorship: PROOF('msg'),
      isEdited: true,
      editedAt: 5,
      editProof: PROOF('edit'),
    });
    const row = replayedStoredRow({ senderId: 'alice', content: 'hello' }, prev, at);
    expect(row.authorship).toEqual(PROOF('msg'));
    expect(row.editProof).toEqual(PROOF('edit'));
  });

  it('never downgrades a proven stored row to unverified', () => {
    const prev = stored({ content: 'signed words', authorship: PROOF('msg') });
    const row = replayedStoredRow(
      { senderId: 'mallory', content: 'relayed words', restoredUnverified: true },
      prev,
      at
    );
    expect(row.restoredUnverified).toBeUndefined();
    expect(row.content).toBe('signed words');
    expect(row.senderId).toBe('alice');
    expect(row.authorship).toEqual(PROOF('msg'));
  });

  it('tombstones a proven stored row when a marked copy carries its author-signed deletion', () => {
    const prev = stored({ content: 'signed words', authorship: PROOF('msg') });
    const row = replayedStoredRow(
      {
        senderId: 'alice',
        content: chat_system_message_deleted(),
        isDeleted: true,
        deleteProof: PROOF('del'),
        restoredUnverified: true,
      },
      prev,
      at
    );
    expect(row.isDeleted).toBe(true);
    expect(row.content).toBe(chat_system_message_deleted());
    expect(row.deleteProof).toEqual(PROOF('del'));
    expect(row.authorship).toBeUndefined();
    expect(row.restoredUnverified).toBeUndefined();
  });

  it('applies the signed edit a marked copy carries onto a proven stored row, never its body', () => {
    const prev = stored({ content: 'signed words', authorship: PROOF('msg') });
    const row = replayedStoredRow(
      {
        senderId: 'alice',
        content: 'signed edit',
        isEdited: true,
        editedAt: 9,
        editProof: PROOF('edit'),
        restoredUnverified: true,
      },
      prev,
      at
    );
    // The signed TEXT onto the proven row's own body - its envelope, never the relayed one.
    expect(envelopeBodyText(row.content)).toBe('signed edit');
    expect(row.isEdited).toBe(true);
    expect(row.editedAt).toBe(9);
    expect(row.editProof).toEqual(PROOF('edit'));
    expect(row.authorship).toEqual(PROOF('msg'));
    expect(row.restoredUnverified).toBeUndefined();
  });

  it('ignores an unsigned edit or deletion a marked copy carries onto a proven stored row', () => {
    const prev = stored({ content: 'signed words', authorship: PROOF('msg') });
    const edited = replayedStoredRow(
      {
        senderId: 'alice',
        content: 'relayed edit',
        isEdited: true,
        editedAt: 9,
        restoredUnverified: true,
      },
      prev,
      at
    );
    expect(edited).toEqual(prev);
    const deleted = replayedStoredRow(
      { senderId: 'alice', content: 'x', isDeleted: true, restoredUnverified: true },
      prev,
      at
    );
    expect(deleted).toEqual(prev);
  });

  it('ignores a signed mutation a marked copy carries when it claims another author', () => {
    const prev = stored({ content: 'signed words', authorship: PROOF('msg') });
    const row = replayedStoredRow(
      {
        senderId: 'mallory',
        content: 'x',
        isDeleted: true,
        deleteProof: PROOF('del'),
        restoredUnverified: true,
      },
      prev,
      at
    );
    expect(row).toEqual(prev);
  });

  it('lets a proven copy replace a stored UNVERIFIED row entirely, its edit state included', () => {
    const prev = stored({
      senderId: 'mallory',
      content: 'relayed words',
      restoredUnverified: true,
      isEdited: true,
      editedAt: 5,
    });
    const row = replayedStoredRow(
      { senderId: 'alice', content: 'signed words', authorship: PROOF('msg') },
      prev,
      at
    );
    expect(row.senderId).toBe('alice');
    expect(row.content).toBe('signed words');
    expect(row.restoredUnverified).toBeUndefined();
    expect(row.isEdited).toBeUndefined();
    expect(row.editedAt).toBeUndefined();
    expect(row.authorship).toEqual(PROOF('msg'));
  });
});

/**
 * Memory after the page's batch write, under the same rule as storage: a row memory shows MARKED that
 * the page wrote PROVEN - here a decrypted original, the case no bundle upgrade reaches - is replaced
 * in the same pass, never left marked until a reload.
 */
describe('provenRowsIntoMemory', () => {
  function shown(extra: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: 'm1',
      senderId: 'mallory',
      content: 'relayed words',
      timestamp: new Date(1),
      isOwn: false,
      restoredUnverified: true,
      isEdited: true,
      editedAt: new Date(5),
      ...extra,
    };
  }
  const original = { senderId: 'alice', content: 'signed words', authorship: PROOF('msg') };

  it('replaces a marked memory row with the proven row the page wrote for its decrypted original', () => {
    const prev = stored({
      senderId: 'mallory',
      content: 'relayed words',
      restoredUnverified: true,
    });
    const written = replayedStoredRow(original, prev, at);
    const next = provenRowsIntoMemory([shown()], [written], 'me');
    expect(next).not.toBeNull();
    const [row] = next!;
    expect(row.senderId).toBe('alice');
    expect(row.content).toBe('signed words');
    expect(row.restoredUnverified).toBeUndefined();
    expect(row.isEdited).toBeUndefined();
    expect(row.editedAt).toBeUndefined();
  });

  it('keeps a tombstone memory holds over the proven body', () => {
    const written = replayedStoredRow(original, undefined, at);
    const [row] = provenRowsIntoMemory([shown({ isDeleted: true })], [written], 'me')!;
    expect(row.senderId).toBe('alice');
    expect(row.isDeleted).toBe(true);
    expect(row.content).toBe(chat_system_message_deleted());
  });

  it('leaves memory alone when the written row is marked too, or memory is not marked', () => {
    const marked = replayedStoredRow(
      { senderId: 'mallory', content: 'relayed words', restoredUnverified: true },
      undefined,
      at
    );
    expect(provenRowsIntoMemory([shown()], [marked], 'me')).toBeNull();
    const proven = replayedStoredRow(original, undefined, at);
    expect(
      provenRowsIntoMemory([shown({ restoredUnverified: undefined })], [proven], 'me')
    ).toBeNull();
  });
});
