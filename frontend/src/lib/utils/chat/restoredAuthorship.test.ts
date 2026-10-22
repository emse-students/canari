import { describe, expect, it } from 'vitest';
import { mkSystem, mkReaction } from '$lib/proto/codec';
import { mkTextEnvelope, serializeEnvelope } from '$lib/envelope';
import { keySource, newTestAuthor, signedBy } from '$lib/crypto/messageAuthorship.testKit';
import {
  vetRestoredDelete,
  vetRestoredEdit,
  vetRestoredMessage,
  vetRestoredReactions,
} from './restoredAuthorship';

/**
 * A HISTORY BUNDLE IS WRITTEN BY WHICHEVER MEMBER ANSWERED, so nothing in it is believed on that
 * member's word: a message, an edit, a deletion or a reaction attributed to SOMEONE ELSE is taken
 * only with that person's own signature (history-reconciliation, "Restored history carries its
 * author's signature"). These tests are the attacks, one per shape.
 */

const GROUP = 'g-restore';
const SENT_AT = 1_700_000_000_000;
const HELLO = { messageId: 'm-1', sentAt: SENT_AT, text: { content: 'hello' } };
const helloContent = serializeEnvelope(mkTextEnvelope('hello'));
const silent = () => {};

async function cast() {
  const alice = await newTestAuthor('alice:dev-a');
  const mallory = await newTestAuthor('mallory:dev-m');
  return { alice, mallory, keys: keySource({ tree: [alice, mallory] }) };
}

describe('a restored message', () => {
  it('is taken from the signed bytes when its author signed it, whoever relays it', async () => {
    const { alice, keys } = await cast();
    const authorship = await signedBy(alice, GROUP, HELLO);
    const verdict = await vetRestoredMessage(
      keys,
      GROUP,
      // The relayer's own fields are lies; the signed bytes win.
      { id: 'm-1', senderId: 'alice', content: 'tampered', timestamp: 1, authorship },
      'mallory',
      silent
    );
    expect(verdict).toMatchObject({ kind: 'verified', content: helloContent, timestamp: SENT_AT });
  });

  it('is never verified when a member forges another member message', async () => {
    const { mallory, keys } = await cast();
    const authorship = await signedBy(mallory, GROUP, HELLO, { claim: 'alice:dev-a' });
    const verdict = await vetRestoredMessage(
      keys,
      GROUP,
      { id: 'm-1', senderId: 'alice', content: helloContent, timestamp: SENT_AT, authorship },
      'mallory',
      silent
    );
    expect(verdict.kind).toBe('unverified');
  });

  it('is REFUSED when a genuine proof is pinned on another message id or another author', async () => {
    const { alice, mallory, keys } = await cast();
    const authorship = await signedBy(alice, GROUP, HELLO);
    for (const entry of [
      { id: 'm-other', senderId: 'alice' },
      { id: 'm-1', senderId: 'bob' },
    ]) {
      const verdict = await vetRestoredMessage(
        keys,
        GROUP,
        { ...entry, content: helloContent, timestamp: SENT_AT, authorship },
        mallory.identity.split(':')[0],
        silent
      );
      expect(verdict.kind).toBe('forged');
    }
  });

  it('never brings back a retracted text as verified: an unproven edit keeps the relayed body, marked', async () => {
    const { alice, keys } = await cast();
    const authorship = await signedBy(alice, GROUP, HELLO);
    const edited = serializeEnvelope(mkTextEnvelope('hello, corrected'));
    const verdict = await vetRestoredMessage(
      keys,
      GROUP,
      {
        id: 'm-1',
        senderId: 'alice',
        content: edited,
        timestamp: SENT_AT,
        authorship,
        isEdited: true,
      },
      'mallory',
      silent
    );
    expect(verdict.kind).toBe('unverified');
  });

  it('verifies an edited message whose signed edit rides with it', async () => {
    const { alice, keys } = await cast();
    const authorship = await signedBy(alice, GROUP, HELLO);
    const editProof = await signedBy(alice, GROUP, {
      messageId: 'e-1',
      ...mkSystem(
        'edit_message',
        JSON.stringify({ messageId: 'm-1', newContent: 'hello, corrected', editedAt: SENT_AT + 5 })
      ),
    });
    const verdict = await vetRestoredMessage(
      keys,
      GROUP,
      {
        id: 'm-1',
        senderId: 'alice',
        content: 'whatever the relayer says',
        timestamp: SENT_AT,
        authorship,
        isEdited: true,
        editProof,
      },
      'mallory',
      silent
    );
    expect(verdict.kind).toBe('verified');
  });

  it('is never VERIFIED by a proof from another conversation - only marked, as if unsigned', async () => {
    const { alice, keys } = await cast();
    const authorship = await signedBy(alice, 'g-other', HELLO);
    const verdict = await vetRestoredMessage(
      keys,
      GROUP,
      { id: 'm-1', senderId: 'alice', content: helloContent, timestamp: SENT_AT, authorship },
      'mallory',
      silent
    );
    // Not forged: a merged DM or a re-key moves a row with its honest proof. Not verified either.
    expect(verdict.kind).toBe('unverified');
  });

  it('is never verified when a proof from another conversation is relabelled as this one', async () => {
    const { alice, keys } = await cast();
    const signed = await signedBy(alice, 'g-other', HELLO);
    const verdict = await vetRestoredMessage(
      keys,
      GROUP,
      {
        id: 'm-1',
        senderId: 'alice',
        content: helloContent,
        timestamp: SENT_AT,
        authorship: { ...signed, group: GROUP },
      },
      'mallory',
      silent
    );
    expect(verdict.kind).toBe('unverified');
  });

  it('is taken on the relayer word when the relayer IS its author', async () => {
    const { keys } = await cast();
    const verdict = await vetRestoredMessage(
      keys,
      GROUP,
      { id: 'm-1', senderId: 'alice', content: helloContent, timestamp: SENT_AT },
      'alice',
      silent
    );
    expect(verdict.kind).toBe('relayer-is-author');
  });

  it('is kept but MARKED when nobody signed it and someone else relays it (an older build)', async () => {
    const { keys } = await cast();
    const verdict = await vetRestoredMessage(
      keys,
      GROUP,
      { id: 'm-1', senderId: 'alice', content: helloContent, timestamp: SENT_AT },
      'mallory',
      silent
    );
    expect(verdict.kind).toBe('unverified');
  });
});

describe('a restored edit', () => {
  const target = { id: 'm-1', senderId: 'alice', content: helloContent };

  it('is applied from the author signed edit, whoever relays it', async () => {
    const { alice, keys } = await cast();
    const editProof = await signedBy(
      alice,
      GROUP,
      mkSystem(
        'edit_message',
        JSON.stringify({ messageId: 'm-1', newContent: 'fixed', editedAt: 5 })
      )
    );
    const verdict = await vetRestoredEdit(keys, GROUP, target, { editProof }, 'mallory', silent);
    expect(verdict).toMatchObject({
      kind: 'apply',
      content: serializeEnvelope(mkTextEnvelope('fixed')),
      editedAt: 5,
    });
  });

  it('is REFUSED when a member signs an edit of another member message', async () => {
    const { mallory, keys } = await cast();
    const editProof = await signedBy(
      mallory,
      GROUP,
      mkSystem(
        'edit_message',
        JSON.stringify({ messageId: 'm-1', newContent: 'pwned', editedAt: 5 })
      )
    );
    const verdict = await vetRestoredEdit(keys, GROUP, target, { editProof }, 'mallory', silent);
    expect(verdict.kind).toBe('forged');
  });

  it('is REFUSED when the author signed edit names another message', async () => {
    const { alice, keys } = await cast();
    const editProof = await signedBy(
      alice,
      GROUP,
      mkSystem('edit_message', JSON.stringify({ messageId: 'm-2', newContent: 'x', editedAt: 5 }))
    );
    const verdict = await vetRestoredEdit(keys, GROUP, target, { editProof }, 'mallory', silent);
    expect(verdict.kind).toBe('forged');
  });

  it('is left to the relayer-is-author rule when it carries no proof', async () => {
    const { keys } = await cast();
    expect((await vetRestoredEdit(keys, GROUP, target, {}, 'alice', silent)).kind).toBe('relayer');
    expect((await vetRestoredEdit(keys, GROUP, target, {}, 'mallory', silent)).kind).toBe('none');
  });
});

describe('a restored deletion', () => {
  const target = { id: 'm-1', senderId: 'alice' };

  it('is applied from the author signed deletion, whoever relays it', async () => {
    const { alice, keys } = await cast();
    const deleteProof = await signedBy(
      alice,
      GROUP,
      mkSystem('delete_message', JSON.stringify({ messageId: 'm-1' }))
    );
    const verdict = await vetRestoredDelete(
      keys,
      GROUP,
      target,
      { deleteProof },
      'mallory',
      silent
    );
    expect(verdict.kind).toBe('apply');
  });

  it('is DROPPED when another member relays a tombstone with no proof - it used to erase the message', async () => {
    const { keys } = await cast();
    const verdict = await vetRestoredDelete(keys, GROUP, target, {}, 'mallory', silent);
    expect(verdict.kind).toBe('none');
  });

  it('is REFUSED when the deletion is signed by someone other than the author', async () => {
    const { mallory, keys } = await cast();
    const deleteProof = await signedBy(
      mallory,
      GROUP,
      mkSystem('delete_message', JSON.stringify({ messageId: 'm-1' }))
    );
    const verdict = await vetRestoredDelete(
      keys,
      GROUP,
      target,
      { deleteProof },
      'mallory',
      silent
    );
    expect(verdict.kind).toBe('forged');
  });

  it('is applied on the author own word', async () => {
    const { keys } = await cast();
    expect((await vetRestoredDelete(keys, GROUP, target, {}, 'alice', silent)).kind).toBe('apply');
  });
});

describe('restored reactions', () => {
  it('keeps the relayer own, the proven ones, and drops a reaction put in another member name', async () => {
    const { alice, keys } = await cast();
    const proof = await signedBy(alice, GROUP, {
      messageId: 'r-1',
      sentAt: 10,
      reaction: { messageId: 'm-1', emoji: '👍', at: 10 },
    });
    const outcome = await vetRestoredReactions(
      keys,
      GROUP,
      'm-1',
      [
        { userId: 'mallory', emoji: '🔥', at: 11 },
        { userId: 'alice', emoji: '👍', at: 10, proof },
        { userId: 'alice', emoji: '💩', at: 12 },
        // A genuine proof re-labelled with another emoji.
        { userId: 'alice', emoji: '❤️', at: 10, proof },
      ],
      'mallory',
      silent
    );
    expect(outcome.kept.map((r) => r.emoji)).toEqual(['🔥', '👍']);
    expect(outcome.unproven).toBe(1);
    expect(outcome.forged).toBe(1);
  });

  it('refuses a reaction proof aimed at another message', async () => {
    const { alice, keys } = await cast();
    const proof = await signedBy(alice, GROUP, mkReaction('m-other', '👍', 10));
    const outcome = await vetRestoredReactions(
      keys,
      GROUP,
      'm-1',
      [{ userId: 'alice', emoji: '👍', at: 10, proof }],
      'mallory',
      silent
    );
    expect(outcome.kept).toEqual([]);
    expect(outcome.forged).toBe(1);
  });
});
