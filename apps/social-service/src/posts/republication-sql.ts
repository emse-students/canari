/**
 * THE KINDS OF ASSOCIATION THAT REPUBLISH, and the allowlist is the point: "only associations and
 * institutions republish" (user, 2026-10-04). A promo LIST does not; an institution is added here
 * the day `associations.type` gains it (WP6e) - a type nobody listed stays refused.
 */
export const REPUBLISHING_ASSOCIATION_TYPES: readonly string[] = ['association'];

/** How a card names an association that republished its post. */
export interface Republisher {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}

/**
 * The republishers of each post in `postIds`, oldest republication first - ONE query for a whole
 * page. A post nobody republished is absent from the map.
 */
export async function republishersOf(
  manager: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  postIds: string[]
): Promise<Map<string, Republisher[]>> {
  const byPost = new Map<string, Republisher[]>();
  if (postIds.length === 0) return byPost;
  const rows: unknown = await manager.query(
    `SELECT pr."postId", a.id, a.name, a.slug, a."logoUrl"
       FROM post_republications pr JOIN associations a ON a.id = pr."associationId"
      WHERE pr."postId" = ANY($1::uuid[])
      ORDER BY pr."republishedAt" ASC, a.name ASC`,
    [postIds]
  );
  if (!Array.isArray(rows)) return byPost;
  for (const row of rows as (Republisher & { postId: string })[]) {
    const list = byPost.get(row.postId) ?? [];
    list.push({ id: row.id, name: row.name, slug: row.slug, logoUrl: row.logoUrl ?? null });
    byPost.set(row.postId, list);
  }
  return byPost;
}

/**
 * What a HIDDEN post loses (D38, user 2026-10-04: "hiding or deleting the original removes every
 * republication"): every republication, and every repost proposal still pending for it.
 *
 * A plain function over a query runner rather than a service method, because two places hide a post
 * - a moderator (`PostsService.hidePostByModeration`) and the report threshold
 * (`ModerationService`), which must not depend on the posts module. A DELETED post needs neither:
 * the foreign key cascades its republications and migration 073's trigger its proposals.
 *
 * Decided proposals stay: a refusal is a record, and a post un-hidden later is republished again
 * only by someone choosing to.
 */
export async function dropRepublicationsOf(
  manager: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  postId: string
): Promise<{ republications: number; proposals: number }> {
  const count = (result: unknown): number =>
    Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
  const republications = count(
    await manager.query(`DELETE FROM post_republications WHERE "postId" = $1`, [postId])
  );
  const proposals = count(
    await manager.query(
      `DELETE FROM proposals WHERE kind = 'repost' AND "subjectId" = $1 AND status = 'pending'`,
      [postId]
    )
  );
  return { republications, proposals };
}
