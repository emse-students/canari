## P3 - the in-app log's cause line fell at a batch seam, and nothing says whether a line can be lost there (iPhone 12, 1.8.2-alpha.8)

target: 1.8.3

**Read.** In the iPhone ring pulled on 2026-11-26 the line that names the sweep's cause (`[HISTORY_RECONCILE] sweeping every group - <reason>`, written by `initializeConnection` through `appendLog`, so a `console.log` the ring captures) was ABSENT while the pass's own line was present; the ring has a record seam at 17:46:07.639-.734 exactly there ([device-verification](../device-verification.md)).

**Audited 2026-11-26, no defect found.** `appLog.ts`: a batch is one record; `flushAppLog` takes `pending` whole at its start and a line pushed during the write goes to the next batch; a failed write puts the lines back in front of the ones that arrived (the suspension and the wipe tests pin it); the only silent drops are `droppedLines` (memory bound, counted in the export header) and `captureConsoleLine`'s re-entrancy guard (a console call made WHILE a line is being captured, counted too). None of these explains a one-line hole between two healthy records, and the pulled ring did not carry the header's counters.

**What closes it.** Make a loss at a seam visible instead of inferred: each stored record carries the sequence number of its first line (per session), and `readAppLog` reports a gap between two consecutive records of one session in the export header (`gapLines`). Test: a failed write whose lines are re-queued leaves no gap; a record removed from the middle is reported. Then the next iPhone pull says whether the seam loses lines, or whether the cause line was simply never written (a build whose connection took the other branch).
