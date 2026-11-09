/**
 * A UNIT SPEC'S STAND-IN FOR `writeComments`' SQL (`comment-write.ts`): `manager.transaction` runs
 * its callback on the same manager, the locked `SELECT comments ... FOR UPDATE` answers the held
 * post's comments, and the `UPDATE posts SET comments` stores them back on it - so a spec reads
 * `post.comments` as the database would hold it. Every other statement goes to `query` unchanged.
 *
 * The real locking is proven against PostgreSQL in `comment-write.integration.spec.ts`.
 */
export function lockedCommentsManager(
  post: { comments?: unknown[] | null },
  query: (sql: string, params?: unknown[]) => Promise<unknown> = () => Promise.resolve([])
) {
  const routed = jest.fn((sql: string, params?: unknown[]) => {
    if (sql.includes('FROM posts WHERE id = $1 FOR UPDATE')) {
      return Promise.resolve([{ comments: post.comments ?? [] }]);
    }
    if (sql.startsWith('UPDATE posts SET comments')) {
      post.comments = JSON.parse(String(params?.[1])) as unknown[];
      return Promise.resolve([]);
    }
    return query(sql, params);
  });
  return {
    query: routed,
    transaction: jest.fn(<T>(work: (m: { query: typeof routed }) => Promise<T>) =>
      work({ query: routed })
    ),
  };
}
