/// <reference types="jest" />

import { PostsService } from './posts.service';
import { SCHEDULED_EDIT_CANDIDATES_SQL, SCHEDULED_EDIT_LIMIT } from './scheduled-edit';

/**
 * WHO IS HANDED A SCHEDULED POST (owner, 2026-11-13): whoever `isPublisherOf` says may edit it, and
 * nobody else. The SQL is proven against PostgreSQL in `scheduled-edit.integration.spec.ts`; here
 * the candidates are given and the PREDICATE is what is exercised - the one `updatePost` applies.
 */
describe('PostsService.getScheduledPostsIMayEdit', () => {
  const ME = '00000000-0000-4000-8000-000000000001';
  const ASSO = '00000000-0000-4000-8000-0000000000a1';
  const OTHER_ASSO = '00000000-0000-4000-8000-0000000000a2';

  function build(
    candidates: { id: string; authorId: string | null; associationId: string | null }[],
    mayAct: jest.Mock
  ) {
    const rows = new Map(candidates.map((c) => [c.id, { ...c, scheduledAt: new Date() }]));
    const repo = {
      manager: { query: jest.fn().mockResolvedValue(candidates) },
      find: jest.fn(async ({ where }: { where: { id: { _value: string[] } } }) =>
        where.id._value.map((id) => rows.get(id)).reverse()
      ),
    };
    const service = new PostsService(
      repo as never,
      {} as never,
      {} as never,
      { mayAct } as never,
      {} as never,
      {} as never
    );
    const serve = jest
      .spyOn(service, 'serveToReader')
      .mockImplementation(async (post) => ({ id: post.id }) as never);
    return { service, repo, serve };
  }

  it('hands a co-editor of an association the post it did not write, in schedule order', async () => {
    const mayAct = jest.fn().mockResolvedValue(true);
    const { service, repo } = build(
      [
        { id: 'p1', authorId: 'someone-else', associationId: ASSO },
        { id: 'p2', authorId: ME, associationId: null },
      ],
      mayAct
    );
    const got = await service.getScheduledPostsIMayEdit(ME);
    expect(got.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(repo.manager.query).toHaveBeenCalledWith(SCHEDULED_EDIT_CANDIDATES_SQL, [ME]);
    expect(mayAct).toHaveBeenCalledTimes(1);
  });

  it('hands a non-editor nothing: an association post without the right, even its own author', async () => {
    const mayAct = jest.fn().mockResolvedValue(false);
    const { service, serve } = build(
      [{ id: 'p1', authorId: ME, associationId: OTHER_ASSO }],
      mayAct
    );
    expect(await service.getScheduledPostsIMayEdit(ME)).toEqual([]);
    expect(serve).not.toHaveBeenCalled();
  });

  it('asks the right once per association and caps the answer', async () => {
    const many = Array.from({ length: SCHEDULED_EDIT_LIMIT + 5 }, (_, i) => ({
      id: `p${i}`,
      authorId: null,
      associationId: ASSO,
    }));
    const mayAct = jest.fn().mockResolvedValue(true);
    const { service } = build(many, mayAct);
    expect(await service.getScheduledPostsIMayEdit(ME)).toHaveLength(SCHEDULED_EDIT_LIMIT);
    expect(mayAct).toHaveBeenCalledTimes(1);
  });

  it('answers nothing for an anonymous caller without touching the database', async () => {
    const { service, repo } = build([], jest.fn());
    expect(await service.getScheduledPostsIMayEdit('')).toEqual([]);
    expect(repo.manager.query).not.toHaveBeenCalled();
  });
});
