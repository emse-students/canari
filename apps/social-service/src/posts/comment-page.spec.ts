import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddCommentDto, EditCommentDto, ListCommentsQueryDto } from './dto/post.dto';
import { COMMENT_MAX_LENGTH, pageComments } from './comment-page';

/** A flat array like the stored JSONB: c0 > r0 > rr0, c1, c2 > r2, c3 (by a blocked account). */
const ALL = [
  { id: 'c0', userId: 'a', parentId: null },
  { id: 'r0', userId: 'b', parentId: 'c0' },
  { id: 'c1', userId: 'a', parentId: null },
  { id: 'rr0', userId: 'a', parentId: 'r0' },
  { id: 'c2', userId: 'c', parentId: null },
  { id: 'r2', userId: 'blocked', parentId: 'c2' },
  { id: 'c3', userId: 'blocked', parentId: null },
];
const ids = (p: { comments: { id: string }[] }) => p.comments.map((c) => c.id);

describe('pageComments cuts whole threads', () => {
  it('returns the newest threads first, replies kept under their head', () => {
    const page = pageComments(ALL, { limit: 2, blockedIds: ['blocked'] });
    expect(ids(page)).toEqual(['c2', 'c1']);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(2);
  });

  it('continues from the cursor and reports the end', () => {
    const page = pageComments(ALL, { cursor: 2, limit: 2, blockedIds: ['blocked'] });
    expect(ids(page)).toEqual(['c0', 'r0', 'rr0']);
    expect(page.hasMore).toBe(false);
  });

  it('walks oldest first to higher positions', () => {
    const first = pageComments(ALL, { order: 'oldest', limit: 1 });
    expect(ids(first)).toEqual(['c0', 'r0', 'rr0']);
    const next = pageComments(ALL, { order: 'oldest', limit: 1, cursor: first.nextCursor });
    expect(ids(next)).toEqual(['c1']);
  });

  it('drops blocked comments and the whole thread under a blocked head', () => {
    const page = pageComments(ALL, { limit: 50, blockedIds: ['blocked'] });
    expect(ids(page)).not.toContain('r2');
    expect(ids(page)).not.toContain('c3');
    expect(ids(page)).toContain('c2');
  });

  it('clamps the limit', () => {
    expect(pageComments(ALL, { limit: 0 }).comments.length).toBeGreaterThan(0);
  });
});

describe('the comment DTOs refuse an over-long text and a bad query', () => {
  const tooLong = 'x'.repeat(COMMENT_MAX_LENGTH + 1);

  it('refuses it on add and on edit', async () => {
    expect(await validate(plainToInstance(AddCommentDto, { text: tooLong }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(EditCommentDto, { text: tooLong }))).not.toHaveLength(0);
    expect(
      await validate(plainToInstance(AddCommentDto, { text: 'x'.repeat(COMMENT_MAX_LENGTH) }))
    ).toHaveLength(0);
  });

  it('parses the page query from strings and refuses an unknown order', async () => {
    const ok = plainToInstance(ListCommentsQueryDto, { cursor: '4', limit: '20', order: 'oldest' });
    expect(await validate(ok)).toHaveLength(0);
    expect(ok.cursor).toBe(4);
    expect(
      await validate(plainToInstance(ListCommentsQueryDto, { order: 'liked' }))
    ).not.toHaveLength(0);
  });
});
