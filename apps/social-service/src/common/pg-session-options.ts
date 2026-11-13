/**
 * The PostgreSQL session settings every social-service connection starts with, as the libpq
 * `options` startup string (node-postgres passes it through), so they hold for every statement on
 * every pooled connection without a transaction around each read.
 *
 * `jit=off`: the read rule (`postVisibleToViewerSql` and the predicates built on it) is one large
 * expression - the bell's statement is about 1,350 JIT functions - and PostgreSQL decides to
 * JIT-compile from the plan's ESTIMATED cost (`jit_above_cost` 100,000, optimisation and inlining
 * past 500,000). The estimate grows with the reader's rows, so a heavy reader crossed it and paid the
 * compilation on every request: measured on dev on 2026-11-09, the bell's statement executes in
 * 9.5 ms without JIT, 1.0-1.1 s with it, 11.7-12.3 s with optimisation and inlining - the 1-3 s and
 * 13 s production answers of `GET /api/posts/notifications`. JIT changes no result, and none of this
 * service's statements scans enough rows to repay a compilation (docs/wiki/frontend/modules/posts.md,
 * "The bell re-checks the post").
 */
export const PG_SESSION_OPTIONS = '-c jit=off';
