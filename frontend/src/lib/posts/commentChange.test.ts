/** A post's comment count, and one thread write applied as a change (`commentChange.ts`). */
import { describe, expect, it } from 'vitest';
import type { PostComment, PostEntity } from '$lib/posts/api';
import { applyCommentChange, commentCountOf, withCommentCountDelta } from './commentChange';

const c = (id: string, parentId: string | null = null): PostComment => ({
  id,
  userId: 'bob',
  text: id,
  parentId,
  likes: [],
  createdAt: '2026-10-19T00:00:00Z',
});

const post = (comments: PostComment[], commentCount?: number): PostEntity =>
  ({ id: 'p', comments, commentCount }) as PostEntity;

describe('commentCountOf', () => {
  it("is the server's total when it sent one", () => {
    expect(commentCountOf(post([c('a')], 57))).toBe(57);
  });
  it('is the rows held from a server older than the field, and never fewer', () => {
    expect(commentCountOf(post([c('a'), c('b')]))).toBe(2);
    expect(commentCountOf(post([c('a'), c('b')], 1))).toBe(2);
  });
});

describe('withCommentCountDelta', () => {
  it('moves a total the server sent, never below zero, and leaves an absent one absent', () => {
    expect(withCommentCountDelta(post([], 3), 1).commentCount).toBe(4);
    expect(withCommentCountDelta(post([], 0), -1).commentCount).toBe(0);
    expect(withCommentCountDelta(post([]), 1).commentCount).toBeUndefined();
  });
});

describe('applyCommentChange', () => {
  it('adds a row it does not hold, and counts it', () => {
    const next = applyCommentChange(post([c('a')], 30), { kind: 'upsert', comment: c('z') });
    expect(next.comments!.map((x) => x.id)).toEqual(['a', 'z']);
    expect(next.commentCount).toBe(31);
  });

  it('replaces a row it holds, and leaves the count', () => {
    const edited = { ...c('a'), text: 'edited' };
    const next = applyCommentChange(post([c('a'), c('b')], 2), { kind: 'upsert', comment: edited });
    expect(next.comments).toEqual([edited, c('b')]);
    expect(next.commentCount).toBe(2);
  });

  it('removes the named rows and their replies, and nothing else', () => {
    const held = [c('a'), c('r', 'a'), c('b')];
    const next = applyCommentChange(post(held, 3), { kind: 'remove', ids: ['a'], count: 2 });
    expect(next.comments!.map((x) => x.id)).toEqual(['b']);
    expect(next.commentCount).toBe(1);
  });
});
