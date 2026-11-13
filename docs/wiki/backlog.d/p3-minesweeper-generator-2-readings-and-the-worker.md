## P3 - Minesweeper generator 2: the readings on real play, and the generation still on the main thread (2026-11-13)

Built and tested; what is owed is what a test cannot give.

- **A reading on a phone that has only met generator 1.** The target (60) comes from ONE person on ONE
  phone playing eight prepared boards. Play two or three real Challenge games in the app and say whether
  the first dig's wait is acceptable and the boards still feel worth playing; the score weights and the
  target are the knobs, and moving either is a NEW generator version.
- **The generation blocks the main thread** for about 0.3 s on a phone (a 90th percentile of 0.4 s in a
  comparison; one earlier run read 2.6 s once and was not reproduced in 75 more boards). A worker would
  keep the screen alive. Not built: decide after the reading above, because a cold start of the worker has
  its own cost.
- **One board in 600 ends its 300-swap budget below 60** (still clearable without a guess). Unexplained
  beyond that; a larger budget is a new version.
- **P2 - the ranking now mixes two kinds of time, and nobody has decided what to do.** The scores table
  holds the best time per player set on generator-1 boards, which are easier; a generator-2 board asks for
  more reasoning and its times will be slower, so an old best is hard to beat. Nothing here separates them
  (a score names its challenge, and a challenge its `"generatorVersion"`, so the leaderboard SQL CAN filter
  or group on it). The owner's choice: keep one ranking, rank generator 2 only, or archive the old times.
  Not built: it changes what a rank means.
- **The fall-back is never silent.** `generationReport.fellBack` is logged as a warning by the screen AND by the
  server's replay (`minesweeper generation fell back`) when no layout the v2 solver clears was found in three
  starts; it read 0 in 800 boards. Count it on dev before trusting the number.

[minesweeper](../frontend/modules/minesweeper.md#generator-v2-owner-2026-11-13).
