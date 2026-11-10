## P2 - engagement: more people notified, following made easy, follow suggestions, a daily push cap (owner, 2026-11-07)

Fourteen decisions of the owner, taken 2026-11-07 in three batches, and the design answering each:
an association's live reaches everyone who sees it, four sources of follow suggestions and four
surfaces, the faces of mutual follows, a per-account bell (posts and lives by default, reduced to
lives or nothing), friends' activity behind a sharing setting that is ON by default, campus trends,
shotgun openings told to followers once, a daily cap of 5 pushes on the NEW kinds only, onboarding in
the feed and suggested posts. **WP-1 (the association live audience) is built; WP-1b (one announced live per association per 6 hours) is built in the same pull request; WP-3 (the bell, with the HELD copy of the association mutes, migration 143) is built 2026-11-08, owed its approval merge, a dev pass and the phone readings; WP-2 (Suivre everywhere: post headers, the directory, association cards; one bulk `POST /api/posts/me/follow-statuses`, `follows/followState.svelte.ts` + `FollowChip`) is built 2026-11-09, owed the phone reading of a follow request from a post header; WP-4 (openings for followers: `opening_reminders`, the HELD copy of `form_reminders`, migration 152, booking and event openings) is built 2026-11-09, owed its approval merge, a dev pass and the phone readings; WP-5 (the suggestion query, `GET /api/posts/me/suggestions`, migration 155) is built 2026-11-09, owed its EXPLAIN on dev; WP-6 (the carousel, the empty Suivis feed, the onboarding banner, "Suivez aussi...") is built 2026-11-09, owed the phone readings; WP-7 (suggested posts in Mon espace, `GET /api/posts/me/suggested-posts`, one in every 8 items) is built 2026-11-09, owed a phone reading; WP-8..WP-10 are
designed, in order, each one small pull request shipping on its own after an adversarial review, a
dev pass and a phone reading.** R1 (the trend threshold: `TREND_THRESHOLD = 4`) and R2 (the cap
check: the cap stays 5) were read on production 2026-11-09. Everything is on
[engagement](../engagement.md).
