## Reading owed - follow suggestions and Suivre, WP-2, WP-5, WP-6, WP-7

target: 1.7.0

**What is built:** follow suggestions and Suivre, WP-2, WP-5, WP-6, WP-7 (#3176, #3237, #3239, #3245, first stable `v1.6.9`; [engagement](../engagement.md#wp-6---the-surfaces-built))

**The reading that closes it:** on the Mi 9T and the iPhone 12: a follow request from a post header; a fresh account sees the banner; Pour toi shows the carousel after the third post and swipes it on both engines; an empty Suivis shows it as the body; a request from a card reads "Demande envoyée"; an X removes a card for good across a reload; "Suivez aussi..." after a follow on a profile; a "Suggestion" post in Pour toi with Suivre in its header, none in Campus

**Triage 2026-11-14: Mi 9T about 25 min, iPhone about 25 min.** **The WP-5 EXPLAIN is READ (2026-11-15, read-only, `EXPLAIN (ANALYZE, BUFFERS)` of the statement as `personSuggestionsSql` builds it, for the production account that follows the most people; 564 users, 328 follows, 409 association memberships): 13.7 ms execution, 18 ms planning, every table small enough for a sequential scan, the follow-pair lookups on their indexes; the review-cohort predicate is left out of the replay (no cohort is in the statement's text), which only adds a per-row comparison. Far under the 26.7 ms of the 2,400-user fixture, so the statement is not a cost to watch.**
