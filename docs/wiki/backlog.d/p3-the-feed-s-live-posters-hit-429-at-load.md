## P3 - the feed's live posters answer 429 at load: `Live poster <id>: 429 - -> rate-limited` (S14, 2026-11-20)

target: 1.7.2

Read on `1.7.1-alpha.6` (dev) ([S14](../device-verification.md#the-readings-of-2026-11-20-s14-171-alpha6-replays-on-both-phones-messages-on-the-mi-9t-the-reactions-at-two-widths)):
at the load of the feed, WARN lines `[LIVE] Live poster <id>: 429 - -> rate-limited` for four to seven lives at once on W1
(7), W4 (6) and the iPhone at its launch (4), with the browsers' matching `Failed to load resource ... 429`. They came after
a reload of three seats together, and again on the iPhone launched alone, so the burst is not the whole cause. Dev holds
about thirty replays of three days.

Not diagnosed: which limiter answers (the status is not the `LIVE_POSTER_TOO_FAST` of the upload route, `api.ts` maps every
429 to `rate-limited`), and whether the covers of those replays then stay blank. To read: the response body and the covers
on a feed with thirty replays, then either space the requests or exempt the cover route. Raise to P2 if a cover stays blank.
