## A SECOND campaign, for everything that is not chat - what is left of it (asked 2026-08-16, audited 2026-11-19)

target: 1.8.0

**Most of its scope has been covered another way, so it is no longer "not started".** The surfaces it
named (posts, forms, communities as a management surface, profiles, media, calendar, payments, and the
lives, reels and moderation added since) were read on both phones and the web in the dated sittings of
[device-verification](../device-verification.md), seeded by `seed-bench.mjs` and the `liverows.mjs`
rows of the rig ([harness README](../../../tools/cross-client-harness/README.md)), and the
server-decided audiences are asserted against PostgreSQL by per-service specs (`feed-audience.guard.spec.ts`,
`post-notifications.*.spec.ts`, `promo-visibility.spec.ts`, the moderation grids). Venue DECIDED
2026-10-18: a test association on the DEV estate only
([WP-SECOND-CAMPAIGN-VENUE](decided-by-the-user-on-2026-10-18-every-design-question-answered.md)).

**The one gap that is real and named** ([cross-client-campaign](../cross-client-campaign.md#the-second-campaign-for-everything-that-is-not-chat---asked-2026-08-16)):
no rig check reads a `social` notification (a post, a comment, a reaction, a form alert, "X est en
live") on the device and asserts that the people OUTSIDE its audience did NOT get it, with the window
sized from a measured latency. That needs the two things the design left to settle: an observer that
classifies the `social-service` log window as `srvlog.mjs` does for chat, and a verdict about absence
over a population. Nothing else of the original scope is owed. **Owner: if the specs and sittings above
are enough, delete this entry** (a deletion needs no code).
