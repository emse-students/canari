/**
 * The boot backfill and a reel's blob.
 *
 * The `archive` backfill re-applies a class to every blob the feed cites, at every boot. A reel's
 * blob is class `reel`, claimed for its author, so that pass must NOT include it - otherwise the
 * very next boot flips every reel's blob to `archive` and silently takes it out of the worker's
 * class. The second pass is the reel's own: each live reel's blob is claimed again for its AUTHOR,
 * because the claim is an ownership proof and a boot has no user to ask.
 */
import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import { PostMediaRetentionService, commentMediaOwners } from './post-media-retention.service';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function makeService(reelRows: Array<{ authorId: string; mediaId: string }>) {
  const sql: string[] = [];
  const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
  const repo = {
    query: jest.fn((statement: string) => {
      sql.push(statement);
      if (/p\.kind = 'reel'/.test(statement)) return Promise.resolve(reelRows);
      return Promise.resolve([{ mediaId: C }]);
    }),
  };
  const http = {
    post: jest.fn((url: string, body: Record<string, unknown>) => {
      posted.push({ url, body });
      return of({ data: { changed: 0, claimed: body.mediaIds, refused: [] } });
    }),
  };
  const service = new PostMediaRetentionService(http as never, repo as never);
  return { service, sql, posted };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('the boot backfill', () => {
  it('excludes a reel from the archive pass, in the SQL that lists what to archive', async () => {
    const { service, sql } = makeService([]);
    await service.onModuleInit();
    const archiveQuery = sql.find((s) => /UNION/.test(s));
    expect(archiveQuery).toContain(`p.kind <> 'reel'`);
  });

  it("claims each live reel's blob for ITS author, one call per author", async () => {
    const { service, sql, posted } = makeService([
      { authorId: 'alice', mediaId: A },
      { authorId: 'bob', mediaId: B },
    ]);

    await service.onModuleInit();

    const claims = posted.filter((p) => p.url.endsWith('internal/reel-claim'));
    expect(claims.map((c) => c.body)).toEqual([
      { mediaIds: [A], ownerId: 'alice' },
      { mediaIds: [B], ownerId: 'bob' },
    ]);
    // Only LIVE reels are claimed: an expired one is the worker's, not this pass's.
    expect(sql.find((s) => /p\.kind = 'reel'/.test(s))).toContain(`p."expiresAt" > NOW()`);
    // And the archive pass never carried a reel's id.
    const archive = posted.find((p) => p.url.endsWith('internal/retention-class'));
    expect(archive?.body).toMatchObject({ mediaIds: [C], retentionClass: 'archive' });
  });

  it('does not claim anything when there is no live reel', async () => {
    const { service, posted } = makeService([]);
    await service.onModuleInit();
    expect(posted.some((p) => p.url.endsWith('internal/reel-claim'))).toBe(false);
  });
});

describe('commentMediaOwners', () => {
  it('pairs each comment media with the comment author, and skips what has no author or media', () => {
    expect(
      commentMediaOwners([
        { id: '1', userId: 'bob', media: { mediaId: A } },
        { id: '2', userId: 'carol' },
        { id: '3', media: { mediaId: B } },
        { id: '4', userId: 'dave', media: { mediaId: C } },
      ])
    ).toEqual([
      { mediaId: A, ownerId: 'bob' },
      { mediaId: C, ownerId: 'dave' },
    ]);
  });

  it('returns nothing for a column that is not an array', () => {
    expect(commentMediaOwners(null)).toEqual([]);
    expect(commentMediaOwners({})).toEqual([]);
  });
});
