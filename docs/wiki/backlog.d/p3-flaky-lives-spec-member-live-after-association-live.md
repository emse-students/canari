## P3 - a lives integration spec failed once: the association's live pushed to nobody

`apps/social-service/src/lives/lives.integration.spec.ts`, "the push to the followers when a live goes
on air (WP-L7) > an association announces at most one live per 6 hours (WP-1b) > a member's live is
never limited by it, even right after the association's", failed once in CI's "Social-service
integration specs (PostgreSQL)" on 2026-11-13: the ASSOCIATION's live was pushed with recipients `[]`
instead of `[BOB]`, while the member's own live still went to `[BOB]`
([run 43444209001](https://github.com/emse-students/canari/actions/runs/43444209001), job
131956873061, on the merge of main into #3461, which touches no lives code). A re-run of the failed
job passed with no change, and the same spec passed on the commit before.

**What is known.** The lives code had not changed on main since the live replays (#3280) and #3314.
An empty recipient list on the association's announcement means the follower read for the
association returned nobody at that instant - an ordering between the spec's `setUp()` (the follow,
the bell) and the announcement, or a row of a previous test of the same block still visible, are the
first two candidates. Neither is measured.

**Owed.** Reproduce (run the block in a loop against a local PostgreSQL), name the overlap, and fix
it at its cause - never a retry or a delay in the spec ([testing-methodology](../testing-methodology.md)).
