# Minesweeper

The easter-egg game in Settings: an 18x32 board with 150 mines (~26% density), generated so that
it can be cleared without guessing, with a ranked leaderboard checked by server-side replay.

| Piece | File |
| --- | --- |
| Engine (generation, solver, play, replay) | `frontend/src/lib/minesweeper/game.ts` |
| Server copy of the engine | `apps/social-service/src/minesweeper/engine/game.ts` |
| Screen | `frontend/src/lib/components/settings/MinesweeperModal.svelte` |
| Challenge issue, replay, scores | `apps/social-service/src/minesweeper/minesweeper.service.ts` |

## Moderation: remove a score, ban a player (2026-10-02)

*"ajoute le fait de pouvoir retirer un score sur demineur, et bannir un utilisateur"* (user). **Global
admins only** - `GlobalAdminGuard` on the server (`X-Global-Admin`, set by nginx from the JWT claim),
and the buttons are drawn for `globalAdminState()` only, the 403 behind them being the real gate.

| Action | Route | Effect |
| --- | --- | --- |
| Remove a score | `DELETE /minesweeper/scores/:scoreId` | deletes THAT row; the player keeps their others, so their next best takes its place |
| Ban a player | `POST /minesweeper/bans` `{userId, reason?}` | out of the RANKED game |
| Lift a ban | `DELETE /minesweeper/bans/:userId` | everything comes back; 404 when there was no ban |
| List the bans | `GET /minesweeper/bans` | newest first, with the name the leaderboard shows |

**A ban is a row, and NOTHING is deleted** (`minesweeper_bans`, migration `070`). Every read asks whether
a ban exists - the leaderboard (`NOT EXISTS`), the rank query (so a banned player's time stops counting
against everyone else's rank), `userStanding` (so a profile badge cannot show a rank they were removed
from) and `me` - so lifting it restores the scores exactly. A ban that destroyed them could not be
undone by a moderator who made a mistake. A banned player **cannot start a challenge or submit one opened
before the ban** (403); the client types that as `MinesweeperBannedError` at the throw and the modal says
*"vous etes banni du classement"* instead of dropping them into an unranked game without a word - they
may still play casually. A moderator cannot ban themselves.

The leaderboard now carries each row's `scoreId`, which is what "remove" names. In the modal's
leaderboard tab an admin gets a remove and a ban button per row, **each behind a confirmation**
(`showConfirm`), and a "Joueurs bannis" list with an unban button; a failed action is said on the tab.

**Verified:** 14 service specs (a ban refuses the challenge and the submit, deletes nothing, is
reversible, a self-ban is refused, an unban of nobody is a 404), the API client and the modal
(six of seven modal tests fail without the change). **NOT verified: the SQL against a PostgreSQL** -
none was available, so the leaderboard and rank statements are only pinned to name `minesweeper_bans`;
and the migration has not been applied to a real database. **Owed:** one look at the tab as an admin.

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
