## P3 - the history stream's arrival filter reads more than it serves (review of #2800, 2026-10-31)

Since #2800 every member of a group conversation but its creator holds a `withheld` window (the span
before their arrival), so `readHistoryStreamPage` filters on EVERY such read: it reads in chunks of
`HISTORY_FULL_PAGE_LIMIT` (1000) whatever the caller asked (200 by default), and keeps reading until
the page is full. Two costs follow, both bounded by `HISTORY_STREAM_MAXLEN` (8000) and the retention
trim, so nothing breaks:

- a newcomer reading with no cursor scans the pre-arrival stream - up to eight XRANGEs of 1000 - on
  every read until their cursor passes the arrival;
- `/history/batch` resolves each group's windows on its own (`ownWithheldWindows`): two more SQL
  reads per group (the group row and the earliest device row), up to 100 in parallel for the 50-group
  cap.

**The fix, not built:** read the group rows and every group's earliest device row ONCE per batch
(one `GROUP BY "groupId"`), and drop a window whose `until` is at or before the instant of `after`
before filtering - a reader whose cursor is past their arrival then reads exactly what it asked for.
Mechanism: [history-reconciliation](../protocols/history-reconciliation.md).
