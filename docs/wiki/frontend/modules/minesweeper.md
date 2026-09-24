# Minesweeper

The easter-egg game in Settings: an 18x32 board with 150 mines (~26% density), generated so that
it can be cleared without guessing, with a ranked leaderboard checked by server-side replay.

| Piece | File |
| --- | --- |
| Engine (generation, solver, play, replay) | `frontend/src/lib/minesweeper/game.ts` |
| Server copy of the engine | `apps/social-service/src/minesweeper/engine/game.ts` |
| Screen | `frontend/src/lib/components/settings/MinesweeperModal.svelte` |
| Challenge issue, replay, scores | `apps/social-service/src/minesweeper/minesweeper.service.ts` |

## A board is a function of the seed AND the first click

The server issues a seed (`randomBytes(16)`) when the first dig happens; mines are placed only
then, keeping the clicked cell's 3x3 mine-free. So one seed has one board PER FIRST CLICK - 576
candidates, of which a sample seed yielded 407 distinct layouts. A question about "the board of
seed X" needs the first click too.

Generation follows Simon Tatham's `mines.c`: place mines, run the solver, and while it is stuck
move mines in or out of a frontier set (`tathamPerturb`), restarting from scratch when that
stalls. If every restart fails, `placeMines` accepts a random layout that may need a guess.

**The solver is sound, not complete.** It opens or flags a cell only when every assignment
consistent with the visible numbers agrees, so a board it clears is provably guess-free. It skips
frontier components above 16 cells, so a board it fails on is NOT proven to need a guess.

**It uses the total mine count**, but only when the whole frontier is one component or the
frontier is empty. That is a legitimate deduction and it matters: seed
`8601e326fcef5ef936a1c69d6ab6ac41`, first click (0,31), ends on five cells in the top-right corner
that no number touches, decidable only because all 150 mines are already found. A player whose
flags do not add up to 150 (flags are manual since auto-flagging was disabled) sees a 1-in-5 guess
there. Forbidding count-based deductions during generation would reject such boards - a product
decision, not taken.

## Generation must not change, only get cheaper

The server replays a ranked game on the board regenerated from `(seed, first click)`, and a
challenge stays open for two hours. Any change to what the generator produces - a solver
deduction, the neighbor ORDER (it fixes constraint order, which feeds the RNG), an extra RNG draw
- rejects every challenge open at deploy time. The two copies are held identical by
`declared-duplicates.test.mjs`; the boards themselves by the fingerprint test in `game.test.ts`,
recorded before the 2026-09-24 speed-up.

## What the first dig costs (2026-09-24)

Measured on 1276 cases (400 random challenge seeds with a random first click, all 576 first clicks
of the seed above, 200 beginner and 100 intermediate boards), Bun on a workstation; a phone is
roughly 3-5x slower:

| | p50 | p90 | p99 | max |
| --- | --- | --- | --- | --- |
| before | 71 ms | 171 ms | 357 ms | 1438 ms |
| after | 12 ms | 33 ms | 59 ms | 125 ms |

Every one of the 1276 boards came out identical, mines and revealed state alike. Two changes did
it. The frontier solver enumerated all 2^n assignments of a component (up to 65536, one array
allocated each, every equation re-checked) - 63% of the time; it is now a depth-first search that
cuts a branch as soon as one equation cannot be met. And the whole-board scans walked neighbors
through a closure per cell; they now read a neighbor table built once per board shape, in the
same order.

The first dig also waits for the challenge round-trip, which nothing here removes. Fetching the
seed when the modal opens would, but the server clock starts at issue, so it needs a separate
"started" signal - an anti-cheat trade-off left undecided.

**The opening cannot be shown before generation ends.** Only the clicked 3x3 is known mine-free
in advance; its numbers, and so the flood extent, depend on mines that perturbation keeps moving
until the end. The screen shows the clicked cell pressed instead, painted before the synchronous
generation starts.
