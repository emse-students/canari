## P1 - the bell answers 500 for any reader holding a `repost_proposed` row (found on dev, 2026-11-04, `1.6.4-alpha.3`)

`GET /api/posts/notifications` fails with `QueryFailedError: operator does not exist: uuid ~* unknown`
for an account that has a `repost_proposed` bell row (measured on dev with `canari-test-delta` and
`canari-test-beta`, each the acceptor of a pending proposal made through `POST
/api/posts/:postId/republication-proposals`; accounts without such a row read their bell normally).

Cause, read from the query the social-service logged: `repostProposalTextWithheldSql` (#3019,
`apps/social-service/src/posts/post-notifications.service.ts`) casts BOTH `n."postId"` and
`n."associationId"` through `asUuidSql`, which tests `column ~* '<uuid shape>'`. `postId` is a
`varchar`, but **`post_notifications."associationId"` is a real `uuid` column** (checked with
`information_schema.columns` on dev), and a `uuid` has no `~*` operator, so the statement fails to
plan. The integration spec passed because its hand-written `CREATE TABLE post_notifications`
declares the column another way; the spec's DDL should come from the migrations, not be restated.
Fix: compare `n."associationId"` as it is (no cast), and make the spec's table the real one.

Every officer of an association that receives a repost proposal loses their bell the moment the
proposal is announced, on production too once this ships. The two bench rows stay on dev to prove
the fix: [the fixtures](../device-verification.md#dev-bench-fixtures-for-the-164-readings-2026-11-04).
