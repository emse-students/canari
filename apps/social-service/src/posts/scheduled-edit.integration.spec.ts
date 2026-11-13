/**
 * THE SCHEDULED POSTS AN EDITOR IS HANDED, against a REAL PostgreSQL (owner, 2026-11-13): the
 * candidate SQL as shipped, then `isPublisherOf` deciding. A stranger gets nothing, the author of a
 * personal post gets it, and a co-editor of an association gets the association's post it did not
 * write; a post already due is no candidate at all.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every integration spec here. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- scheduled-edit.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { Client } from 'pg';
import { PostsService } from './posts.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AUTHOR = id(1);
const CO_EDITOR = id(2);
const STRANGER = id(3);
const ASSO = id(100);
const P_PERSONAL = id(201);
const P_ASSO = id(202);
const P_DUE = id(203);
const P_REEL = id(204);

maybe('the scheduled posts an editor is handed, against PostgreSQL', () => {
  const schema = `scheduled_edit_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;
  let service: PostsService;

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`CREATE TABLE posts (
      id uuid PRIMARY KEY, "authorId" uuid, "associationId" uuid,
      kind text, "scheduledAt" timestamptz)`);
    const ins = (pid: string, author: string, assoc: string | null, when: string, kind = 'post') =>
      client.query(
        `INSERT INTO posts (id, "authorId", "associationId", kind, "scheduledAt")
         VALUES ($1, $2, $3, $4, NOW() + $5::interval)`,
        [pid, author, assoc, kind, when]
      );
    await ins(P_PERSONAL, AUTHOR, null, '2 hours');
    await ins(P_ASSO, AUTHOR, ASSO, '1 hour');
    await ins(P_DUE, AUTHOR, null, '-1 hour');
    await ins(P_REEL, AUTHOR, null, '3 hours', 'reel');
    const repo = {
      manager: { query: (sql: string, p?: unknown[]) => client.query(sql, p).then((r) => r.rows) },
      find: async ({ where }: { where: { id: { _value: string[] } } }) =>
        where.id._value.map((pid) => ({ id: pid })),
    };
    // The right to speak for ASSO: the author and the co-editor hold it, a stranger does not.
    const mayAct = async (user: string, asso: string) =>
      asso === ASSO && (user === AUTHOR || user === CO_EDITOR);
    service = new PostsService(
      repo as never,
      {} as never,
      {} as never,
      { mayAct } as never,
      {} as never,
      {} as never
    );
    jest.spyOn(service, 'serveToReader').mockImplementation(async (p) => ({ id: p.id }) as never);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });

  const idsFor = async (user: string) =>
    (await service.getScheduledPostsIMayEdit(user)).map((p) => p.id);

  it('the author gets its personal post and the association post, soonest first', async () => {
    expect(await idsFor(AUTHOR)).toEqual([P_ASSO, P_PERSONAL]);
  });

  it('a co-editor of the association gets the post it did not write, and nothing else', async () => {
    expect(await idsFor(CO_EDITOR)).toEqual([P_ASSO]);
  });

  it('a non-editor gets nothing', async () => {
    expect(await idsFor(STRANGER)).toEqual([]);
  });
});
