/**
 * WHO CAN SEE THE SOCIAL FEED, AS SQL - and the reason this file exists rather than one more
 * inline `WHERE`.
 *
 * The rule is "ICM students, plus global admins". Until 2026-09-10 it was stated TWICE and both
 * times in the CLIENT - `routes/posts/+page.ts` and `routes/posts/[postId]/+page.ts` each carried
 * the same eleven-line redirect, and **the backend had no such gate at all**. Announcing posts
 * needs the rule server-side to know who to tell, and adding it inline would have made three
 * copies of one decision in two languages.
 *
 * So the client's two copies became one (`$lib/posts/feedAudience.ts`) and the server's is this,
 * and the pair is the smallest number this can be until the gate itself moves to the API. **That
 * is still owed**: this constant decides who is TOLD about a post, not who may READ one, and
 * nothing here closes the hole that `GET /api/posts` answers anybody who asks.
 */

/**
 * The audience, as a `WHERE` fragment over `users`.
 *
 * A fragment and not a full query because its two callers select different things - the id list to
 * notify, and the count that sizes it - and a view would put a schema object in the way of a rule
 * that has to stay legible beside its client twin.
 */
export const FEED_AUDIENCE_WHERE = `formation = 'ICM' OR admin = true`;

/** Every user who can see the feed, and therefore everybody an association's post is announced to. */
export const FEED_AUDIENCE_IDS_SQL = `SELECT id FROM users WHERE ${FEED_AUDIENCE_WHERE}`;

/**
 * Whether ONE user is in the audience - the question the API gate asks, `$1` being their id.
 *
 * THE PARENTHESES ARE THE WHOLE POINT AND ARE NOT COSMETIC. `AND` binds tighter than `OR`, so
 * `WHERE id = $1 AND formation = 'ICM' OR admin = true` parses as
 * `(id = $1 AND formation = 'ICM') OR (admin = true)` - true for EVERY admin row in the table,
 * whoever asked. The gate would then answer "yes" to an anonymous caller for as long as the
 * school has one administrator. A fragment meant to be combined has to say so, and this is why
 * the combining lives here beside it rather than at each call site. Measured on the local copy of
 * production with an id belonging to nobody: **4 rows without the parentheses, 0 with them** -
 * the four are exactly the school's four administrators.
 *
 * `EXISTS` rather than a row count: the question is a boolean, an id that matches nothing is a
 * clean `false`, and it stops at the first match.
 */
export const IS_FEED_AUDIENCE_SQL = `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND (${FEED_AUDIENCE_WHERE})) AS "inAudience"`;
