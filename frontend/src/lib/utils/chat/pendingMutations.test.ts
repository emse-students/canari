/**
 * `settleAgainstPending`: what a message that arrives AFTER its mutations takes from them - the
 * AUTHOR's deletion, else the author's latest edit, then everyone's reactions - and that nobody
 * else's deletion or edit is ever applied, whatever order the entries come in.
 */
import { settleAgainstPending } from './pendingMutations';
import { m } from '$lib/paraglide/messages';
import type { PendingMutation } from '$lib/db/types';

const body = { id: 'm1', senderId: 'alice', content: 'hello' };
const e = (over: Partial<PendingMutation>): PendingMutation => ({
  conversationId: 'g1',
  messageId: 'm1',
  sender: 'alice',
  kind: 'delete',
  slot: '',
  rank: 0,
  at: 1,
  ...over,
});

describe('settleAgainstPending', () => {
  it("applies the author's deletion, purging the body and its proofs", () => {
    const proof = { signature: 's' } as never;
    const out = settleAgainstPending(body, [e({ proof })]);
    expect(out.fields).toEqual({
      isDeleted: true,
      content: m.chat_system_message_deleted(),
      authorship: null,
      editProof: null,
      deleteProof: proof,
    });
    expect(out.discarded).toEqual([]);
  });

  it("discards a non-author's deletion - and it cannot stand in front of the author's", () => {
    const mallory = e({ sender: 'mallory' });
    expect(settleAgainstPending(body, [mallory])).toEqual({
      fields: null,
      discarded: [mallory],
      retained: [],
      consumed: [mallory],
    });
    // Both kept (one entry per sender): the author's still applies.
    const both = settleAgainstPending(body, [mallory, e({})]);
    expect(both.fields?.isDeleted).toBe(true);
    expect(both.discarded).toEqual([mallory]);
  });

  it("RETAINS a non-author deletion or edit when the body's author is only a claim - nothing applied, nothing consumed", () => {
    const mallory = e({ sender: 'mallory' });
    const forged = e({ sender: 'mallory', kind: 'edit', rank: 9, text: 'x' });
    const reaction = e({ sender: 'mallory', kind: 'reaction', slot: '👍', rank: 3 });
    const out = settleAgainstPending({ ...body, restoredUnverified: true }, [
      mallory,
      forged,
      reaction,
    ]);
    expect(out.fields?.isDeleted).toBeUndefined();
    expect(out.fields?.content).toBeUndefined();
    expect(out.discarded).toEqual([]);
    expect(out.retained).toEqual([mallory, forged]);
    // The reaction is everyone's, so it is applied and consumed whatever the authorship.
    expect(out.consumed).toEqual([reaction]);
    // Once the body is PROVEN, the same entries are discarded for good.
    expect(settleAgainstPending(body, [mallory, forged]).consumed).toEqual([mallory, forged]);
  });

  it("applies the author's LATEST edit and never a non-author's, however far in the future", () => {
    const mallory = e({ sender: 'mallory', kind: 'edit', rank: 9e15, text: 'forged' });
    const out = settleAgainstPending(body, [
      e({ kind: 'edit', rank: 20, text: 'second' }),
      mallory,
      e({ kind: 'edit', rank: 10, text: 'first' }),
    ]);
    expect(out.fields).toMatchObject({ isEdited: true, editedAt: 20, editProof: null });
    expect(out.fields?.content).toContain('second');
    expect(out.discarded).toEqual([mallory]);
  });

  it('keeps an edit the body already carries when the pending one is older', () => {
    const out = settleAgainstPending({ ...body, isEdited: true, editedAt: 50 }, [
      e({ kind: 'edit', rank: 10, text: 'older' }),
    ]);
    expect(out.fields).toBeNull();
  });

  it('lets no edit rewrite a deletion, and changes nothing on an existing tombstone', () => {
    const out = settleAgainstPending(body, [e({ kind: 'edit', rank: 10, text: 'x' }), e({})]);
    expect(out.fields?.isDeleted).toBe(true);
    expect(out.fields?.isEdited).toBeUndefined();
    expect(settleAgainstPending({ ...body, isDeleted: true }, [e({})]).fields).toBeNull();
  });

  it("folds everyone's reactions, last write winning per reactor and emoji", () => {
    const out = settleAgainstPending(
      { ...body, reactions: [{ emoji: '👍', userId: 'bob', at: 5 }] },
      [
        e({ sender: 'bob', kind: 'reaction', slot: '👍', rank: 9, removed: true }),
        e({ sender: 'carol', kind: 'reaction', slot: '🎉', rank: 3 }),
      ]
    );
    expect(out.fields?.reactions).toEqual([
      { emoji: '👍', userId: 'bob', at: 9, removed: true },
      { emoji: '🎉', userId: 'carol', at: 3, removed: false },
    ]);
  });

  it('reaches the same result whatever order the entries come in', () => {
    const entries = [
      e({ kind: 'edit', rank: 20, text: 'b' }),
      e({ kind: 'edit', rank: 20, text: 'a' }),
      e({ sender: 'bob', kind: 'reaction', slot: '👍', rank: 4 }),
    ];
    const one = settleAgainstPending(body, entries);
    const other = settleAgainstPending(body, [...entries].reverse());
    expect(one.fields).toEqual(other.fields);
  });
});
