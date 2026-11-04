import type { StoredComment } from './comment-identity';
import { planCommentRemoval, pruneEmptyTombstones } from './comment-removal';

/**
 * WHAT A COMMENT'S DELETE TAKES (lead, 2026-11-04): descendants recursively, one rule at every
 * level, a tombstone where something the deleter may not remove must keep its context.
 */
const AT = '2026-11-04T12:00:00.000Z';
const c = (id: string, parentId: string | null, extra: Partial<StoredComment> = {}) =>
  ({
    id,
    parentId,
    userId: `u-${id}`,
    text: `text ${id}`,
    createdAt: AT,
    ...extra,
  }) as StoredComment;
/** The deleter may remove everything but what an institution publishes. */
const notInstitution = (x: StoredComment) => x.associationId !== 'inst';
const ids = (list: StoredComment[]) => list.map((x) => x.id);

describe('planCommentRemoval', () => {
  it('takes every descendant, not only the direct replies', () => {
    const list = [c('a', null), c('b', 'a'), c('c', 'b'), c('d', 'c'), c('other', null)];
    const plan = planCommentRemoval(list, 'a', () => true, AT);
    expect(ids(plan.comments)).toEqual(['other']);
    expect(ids(plan.removed).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(plan.tombstoned).toEqual([]);
  });

  it("tombstones the parent of an institution's reply, and keeps that reply in its context", () => {
    const media = { mediaId: 'm-a' };
    const list = [
      c('a', null, { media, mentions: ['x'] }),
      c('inst-r', 'a', { associationId: 'inst' }),
      c('student-r', 'a'),
    ];
    const plan = planCommentRemoval(list, 'a', notInstitution, AT);
    expect(ids(plan.comments)).toEqual(['a', 'inst-r']);
    expect(ids(plan.removed)).toEqual(['student-r']);
    const stored = plan.comments[0];
    expect(stored).toEqual({
      id: 'a',
      parentId: null,
      userId: 'u-a',
      createdAt: AT,
      text: '',
      likes: [],
      removedByModeration: true,
      removedAt: AT,
    });
    // The tombstone's original goes back to the caller, so its media are released.
    expect(plan.tombstoned[0].before.media).toEqual(media);
  });

  it('applies the same rule at every level: a deep protected reply tombstones its whole chain', () => {
    const list = [
      c('a', null),
      c('b', 'a'),
      c('inst-c', 'b', { associationId: 'inst' }),
      c('d', 'inst-c'), // under the protected reply, removable: it goes
      c('e', 'a'),
    ];
    const plan = planCommentRemoval(list, 'a', notInstitution, AT);
    expect(ids(plan.comments)).toEqual(['a', 'b', 'inst-c']);
    expect(plan.comments.slice(0, 2).every((x) => x.removedByModeration === true)).toBe(true);
    expect(ids(plan.removed).sort()).toEqual(['d', 'e']);
  });

  it('removes a tombstone left with no reply, here and on a later delete', () => {
    const first = planCommentRemoval(
      [c('a', null), c('inst-r', 'a', { associationId: 'inst' })],
      'a',
      notInstitution,
      AT
    );
    // Later the institution's reply is deleted (by the platform admin, or by the institution):
    const second = planCommentRemoval(first.comments, 'inst-r', () => true, AT);
    expect(second.comments).toEqual([]);
    expect(ids(second.removed).sort()).toEqual(['a', 'inst-r']);
  });

  it('leaves the list untouched for an unknown id, and survives a cycle in stored parent ids', () => {
    const list = [c('a', 'b'), c('b', 'a')];
    expect(planCommentRemoval(list, 'zz', () => true, AT).comments).toEqual(list);
    expect(planCommentRemoval(list, 'a', () => true, AT).comments).toEqual([]);
  });

  it('pruneEmptyTombstones removes nested empty tombstones in one call', () => {
    const t = (id: string, parentId: string | null) =>
      c(id, parentId, { removedByModeration: true });
    const { comments, pruned } = pruneEmptyTombstones([t('a', null), t('b', 'a'), c('z', null)]);
    expect(ids(comments)).toEqual(['z']);
    expect(ids(pruned).sort()).toEqual(['a', 'b']);
  });
});
