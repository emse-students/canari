## P3 - the history stream's arrival filter reads more than it serves (review of #2800, 2026-10-31)

target: 1.10.0

Since #2800 every member of a group conversation but its creator holds a `withheld` window (the span
before their arrival), so `readHistoryStreamPage` filters on EVERY such read: it reads in chunks of
`HISTORY_FULL_PAGE_LIMIT` (1000) whatever the caller asked (200 by default), and keeps reading until
the page is full. Two costs followed, both bounded by `HISTORY_STREAM_MAXLEN` (8000) and the retention
trim, so nothing breaks:

- a newcomer reading with no cursor scans the pre-arrival stream - up to eight XRANGEs of 1000 - on
  every read until their cursor passes the arrival;
- `/history/batch` resolved each group's windows on its own: two more SQL reads per group (the group
  row and the earliest device row), up to 100 in parallel for the 50-group cap.

**The second cost is fixed (2026-11-12):** `arrivalFactsOf` reads the group rows and every group's
earliest device row ONCE per request (one `IN (...)`, one `GROUP BY "groupId"`), and
`ownWithheldWindows` takes them from that map. If the facts cannot be read, the batch answers every
group empty with one ERROR line and never serves them unfiltered.

**The first cost stays, and the planned fix for it is REFUSED.** The plan was to drop a window whose
`until` is at or before the instant of `after`. That is unsafe: a stream row's `timestamp` is
`receivedAt`, taken at the START of the send (`messaging.service.ts`, the send path), about fifteen
awaits before the `XADD` that gives the row its id. Two sends that overlap can be appended in the
opposite order to their `receivedAt`, so the instant of a cursor does not bound the instants of the
rows after it. A window dropped by the cursor could serve a row from before the reader's arrival. A
safe version needs a discriminator in stream order, such as the stream id of the reader's arrival,
and no such value is stored today. The cost remains bounded, so this stays P3.
Mechanism: [history-reconciliation](../protocols/history-reconciliation.md).
