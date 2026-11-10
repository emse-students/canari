/**
 * HOW MANY DISTINCT ACCOUNTS ENGAGED WITH A POST, as SQL over a `posts` row: the reactors (the keys
 * of `posts.reactions`) and the comment writers (`posts.comments[*].userId`), its author excluded.
 * ONE definition for what makes a post popular (a suggested post, engagement WP-7) and what makes it
 * take off (a campus trend, WP-10, and the production reading R1 of docs/wiki/engagement.md).
 *
 * A comment's `userId` is its writer's REAL id whatever it says it is (`comment-identity.ts`), so an
 * anonymous comment or one written as an association still counts its writer once - only a NUMBER
 * leaves this expression, never an id.
 */
export function engagedAccountsSql(post: string): string {
  return `(SELECT count(DISTINCT eng_x) FROM (
      SELECT jsonb_object_keys(CASE WHEN jsonb_typeof(${post}.reactions) = 'object'
                                    THEN ${post}.reactions ELSE '{}'::jsonb END) AS eng_x
      UNION
      SELECT eng_c->>'userId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${post}.comments) = 'array'
                                                             THEN ${post}.comments ELSE '[]'::jsonb END) eng_c
    ) eng_s WHERE eng_x IS NOT NULL AND eng_x <> ${post}."authorId")`;
}
