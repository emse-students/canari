## P3 - Minesweeper: the first dig's generation blocks the main thread (2026-11-14)

target: 1.8.0

Generator 2 climbs for about 0.3 s on a phone (a 90th percentile of 0.4 s in a back-to-back comparison; one
earlier run read 2.6 s once and was not reproduced in 75 more boards), synchronously, at the first dig; the
screen paints the pressed cell first. A worker would keep the interface alive. **Not built: decide after
the reading on a real phone, owed once generator 2 ships in a stable**, because a cold start
of the worker has its own cost.

Also unexplained: one board in 600 ends its 300-swap budget below the target score (it is still clearable
without a guess). A larger budget is a new generator version.

[minesweeper](../frontend/modules/minesweeper.md#generator-v2-owner-2026-11-13).
