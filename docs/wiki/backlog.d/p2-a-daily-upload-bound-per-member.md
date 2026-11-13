## Reading owed - the daily upload bound's refusal rate a week after its release

target: 1.7.0

**Decided (lead, 2026-11-13, under the owner's delegation; reversible):** one member may upload
2 GB per rolling 24 hours, every class and every upload route together (the plain upload, the
legacy chunked routes, the resumable sessions). The `chat-reel` budget of 500 MB keeps its own
count beside it. Outside the bound on purpose: public assets, which have no owner, and what
arrives server-to-server under its own cap (a form's file, a live's segments). The value is `MEDIA_MEMBER_DAILY_UPLOAD_BYTES`, 2 GB when unset
([media-service](../services/media-service.md)).

**What it was chosen from.** One read-only aggregate of production's media index on 2026-11-13,
over the 60 days before it: 853 uploads by 123 members on 351 member-days; uploads per member per
day p50 1, p95 8, p99 13, max 22. The index recorded no size for these classes, so no byte figure
exists for that window; the per-file ceiling is 100 MB, so the busiest day measured stays under the
bound unless its files averaged more than 90 MB.

**How it works.** Every upload now records its size in the index, and the bound sums the member's
entries of the last 24 hours plus what is reserved and not yet registered, in the same synchronous
run that reserves the new bytes (the mechanism of the `chat-reel` budget). A refusal is a 422 whose
body carries `code: member-upload-over-budget`; the client reads the code, fails the message for
good and says so in the thread. It is a 422 and not a 429 because an app released before the code
reads only the status: it retries an attachment answered 429 each minute with no count, and fails
one answered 422 for good with its generic line. Uploads stored before the change carry no size, so the bound is
complete one day after it ships.

**Owed.** One week after the stable that carries it, count the `[MEMBER_UPLOAD_BUDGET]` WARN lines
of media-service on production: each names the member's uploads and bytes of the day. Zero lines
closes this entry; a line for an ordinary day of use means the value is too low and is raised
through the variable. From that same week the index holds sizes, so bytes per member per day (p50,
p95, max) can be read from it and written here in place of the count-only measurement.
