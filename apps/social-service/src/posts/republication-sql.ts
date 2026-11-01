/**
 * THE KINDS OF ASSOCIATION THAT REPUBLISH, and the allowlist is the point: a type nobody listed
 * stays refused. "Only associations and institutions republish" (user, 2026-10-04); an institution
 * joined with WP6e (migration 075); a campaign LIST joined on 2026-10-31 (owner: lists gain the
 * publications section, `POST_AS_ASSO` / `PROPOSE_EVENT`).
 */
export const REPUBLISHING_ASSOCIATION_TYPES: readonly string[] = [
  'association',
  'list',
  'institution',
];

/**
 * THE KINDS OF ASSOCIATION THAT MAY ASK A PERSON TO REPUBLISH THEIR POST (D38b): associations only.
 * The user asked for "republier en tant qu'association" (2026-10-19), and an INSTITUTION carrying a
 * student's personal post is what D34-D36 rule out ("never a student's personal post" reaches the
 * personnel side): it stays refused until somebody decides otherwise. A list is refused here too (the owner's 2026-10-31 widening covers republishing INTO a list, not a person's consent to it).
 */
export const PERSONAL_REPUBLISHING_ASSOCIATION_TYPES: readonly string[] = ['association'];

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
 * republication"): every republication, and every repost proposal still pending for it -
 * an association's request to the AUTHOR of a personal post (D38b) included.
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
      `DELETE FROM proposals WHERE kind IN ('repost', 'repost-personal') AND "subjectId" = $1
          AND status = 'pending'`,
      [postId]
    )
  );
  return { republications, proposals };
}

/**
 * Row-locks a post (`FOR UPDATE`) BEFORE any proposal row about it is written - the subject lock of
 * `ProposalsService.lockInOrder`, taken by every decision (accept, refuse, withdraw) and every
 * person-addressed ask. A moderation hide locks the post (its `UPDATE`) and then deletes the pending
 * proposals, and a post delete does the same through its trigger; an acceptance that took the
 * proposal first and the post second (in `writeRepublication`) could wait on a hide that waits on
 * it. The other writers keep the same order on purpose, and each says so where it does: the account
 * erasure scrubs posts before it touches a proposal (`ERASURE_PROPOSAL_STATEMENTS`), a republication
 * withdrawal locks the post first (`RepublicationsService.unrepublish`), and an association delete,
 * which locks the association first, is waited on by `lockInOrder`'s `KEY SHARE`. A new writer of
 * proposals that does not lock the post first re-opens the deadlock, and the lock-order cases of
 * `personal-republications.integration.spec.ts` are what find it.
 */
export async function lockPostRow(
  manager: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  postId: string
): Promise<void> {
  await manager.query(`SELECT 1 FROM posts WHERE id = $1 FOR UPDATE`, [postId]);
}
