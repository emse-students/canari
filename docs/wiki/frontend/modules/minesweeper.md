# Minesweeper

The easter-egg game in Settings: an 18x32 board with 150 mines (~26% density), generated so that
it can be cleared without guessing, with a ranked leaderboard checked by server-side replay.

| Piece | File |
| --- | --- |
| Engine (generation, solver, play, replay) | `frontend/src/lib/minesweeper/game.ts` |
| Server copy of the engine | `apps/social-service/src/minesweeper/engine/game.ts` |
| Screen | `frontend/src/lib/components/settings/MinesweeperModal.svelte` |
| THE leaderboard (ranking, promo, Stats, moderation) | `frontend/src/routes/games/+page.svelte`, `frontend/src/lib/components/games/MinesweeperStats.svelte` |
| View geometry (fit, bounds, zoom, flick) | `frontend/src/lib/minesweeper/view.ts` |
| Vibration patterns | `frontend/src/lib/minesweeper/haptics.ts` |
| Player settings (per device) | `frontend/src/lib/minesweeper/settings.ts` |
| Per-cell diff behind the render | `frontend/src/lib/minesweeper/cellViews.ts`, `MinesweeperCell.svelte` |
| Challenge issue, replay, scores | `apps/social-service/src/minesweeper/minesweeper.service.ts` |

## The screen is the board (2026-10-07)

*"affichage plein ecran, avec juste un bouton classement qui flotte en haut a droite"* and *"amelioration de
la fluidite et de la facilite de controle"* (user). The modal has no title bar and no tabs: on a phone it
fills the screen (`phoneFullScreen`), on a desktop it stays a 96vw/96dvh dialog. Everything else floats
over the board:

| Control | Where | Notes |
| --- | --- | --- |
| Close, mines left, timer, restart | top left | the close is the only way out on iOS, which has no back gesture |
| Leaderboard | top right, trophy icon only | closes the game and goes to the Games page (`/games`), THE one leaderboard since 2026-11-13; the game has no sheet of its own |
| Ranked / unranked | bottom, beside the mode | **"Libre" = no challenge is requested at the first dig**, so nothing is submitted; stored in `canari.minesweeper.unranked`; locked once the first cell is dug, since a game's ranking is decided when its board is generated |
| Mode (dig / flag) | bottom centre, thumb reach | what a SHORT press does; a long press does the other. Same stored setting as the old "flags first" |

**No zoom buttons.** Pinch, wheel (proportional to the delta, so a trackpad pinch is smooth), and a
double-tap. The double-tap zooms in on the tapped point and out to the fit; it only counts when the first
tap DUG - a second tap on a cell the first tap flagged is a real second action (an unflag), never a zoom.

**Controls.** The board is FITTED as large as the padded screen allows (it used to stop at 1x), refits on
rotation or resize until the player has moved it, and can never be dragged or zoomed out of reach
(`clampView`). A drag works with a plain mouse press too, a flick glides and stops against an edge, the
long press is 350 ms (was 450) with a progress ring drawn above the finger, and the phone vibrates on a
long press, a win and a loss. Cell handlers are delegated from the grid (one set, not five per cell).

**Fixed on the way:** a pinch left `justPanned` set, so the NEXT tap was swallowed; and the browser's
touch `contextmenu` reset the long-press flag, letting the trailing click run the primary action on the
cell just flagged.

Nothing here touches the engine or the move log, so the server replay and the generation fingerprint are
unaffected. **Verified:** the geometry (`view.test.ts`), the chrome and the moderation sheet in jsdom.
**NOT verified: how it feels** - no gate here sees a gesture; owed ONE look on the Mi 9T and the iPhone
(fit, flick, double-tap, the ring, the vibration).

## ONE leaderboard: the Games page (owner, 2026-11-13)

The game used to carry its own "Classement" sheet (ranking, Stats, admin moderation) next to the
Games page's ranking. The sheet is DELETED; `/games` is the only leaderboard and the trophy leads
there. The page has three tabs - overall, per promo, **Stats** - and carries over everything the
sheet had: each ranking row shows the date of the record (`verifiedAt` through `exactDate`, so
**no migration**: the date was already on the score row and in the leaderboard payload); the Stats
tab (`MinesweeperStats.svelte`, loaded when opened) shows ranked games played, wins, lost or
abandoned, win rate, rank, best, average and median time, the sparkline of the latest wins and their
dated list, and the "ranked games only" note; a global admin gets the remove-score and ban buttons
per row and the banned list with unban, each behind a confirmation. The settings sheet stays in the
game (it is about input, not ranking). Pinned by `page.svelte.test.ts`, `page.moderation.svelte.test.ts`,
`MinesweeperStats.svelte.test.ts`, `MinesweeperModal.chrome.svelte.test.ts`. The two sections below
describe the stats and paging mechanics, now on the page (page size 25, "Voir plus").

## Stats, paging, settings and the cell diff (2026-11-04)

*Asked:* a stats tab, relative dates and pages in the ranking, a settings panel, less lag on a big
reveal or rapid taps. The engine (`game.ts` and its server twin) is untouched: open challenges are
replayed on it.

**What the server can know.** A casual game never opens a challenge, so it is never reported. The
server holds the player's CHALLENGES (`minesweeper_challenges`) and every win (`minesweeper_scores`,
all of them - `DISTINCT ON` only happens at leaderboard time). `GET /minesweeper/stats` therefore
reports RANKED games only: `played` = challenges, `won` = scores, `lost` = the difference (lost,
abandoned, rejected, expired), plus best / average / median (`percentile_cont`), the latest 10 wins and
the current rank. No migration. The tab says so in a note. A win with no challenge row cannot happen,
but `played` is floored at `won` so the rate never exceeds 100%.

**Paging.** `GET /minesweeper/leaderboard?limit=&offset=` returns `{entries, total}`; ranks continue
(`offset + i + 1`), the 50-per-page cap stands, a negative or fractional offset is clamped. The sheet
loads 10, "Voir plus" appends the next page from where the loaded ones end, and the button goes when
`entries.length >= total`. Any moderation action reloads page one. The server still builds the whole
`DISTINCT ON` set per request - fine at this population, a cache is the lever if it grows. Each row
shows `verifiedAt` through `formatRelative` (`utils/time.ts`), the exact date in the tooltip.

**Settings** (`settings.ts`, `canari.minesweeper.settings`, per device, validated field by field):

| Setting | Default | Reads |
| --- | --- | --- |
| Double-tap zoom | on | the double-tap branch of `handleGridClick` |
| Long-press delay | 350 ms, 150-600 in steps of 50 (the floor was 200 until 2026-11-13) | the long-press timer AND the ring's duration |
| Vibrations | on | `buzz()` in front of every `haptic()` call |
| Animation speed | normal; `off` when the system asks for reduced motion and nothing is stored | zoom transition, overlay fade/scale, win glow (CSS `--ms-anim`) |

A setting changes how input is READ and how the screen MOVES, never what a move is.

**The cell look: "flat tonal" (user's pick among four, 2026-11-04).** Flat `rounded-md` tiles, no
border. A hidden cell is `--cn-bg` pulled 14% toward `--text-main` (22% on hover where one exists, 30%
pressed), so one rule follows both themes; a revealed one is `--cn-surface` in light and `--cn-bg` in
dark. Numbers are a deep shade in light and a bright one in dark (the old `-600/-700` ones were nearly
unreadable on black), flags amber / gold, the mine `red-600`. The four candidates, light and dark, were
compared as static mock-ups before the pick; the rejected ones (raised slate, gold-tinted, glow) are not
kept. **The same look runs through the whole section** (user, 2026-11-04): no borders anywhere. A
sheet row, card, the sparkline panel and the "show more" button are `.ms-tile` (the surface pulled 7%
toward `--text-main`), the pills floating over the board are `.ms-chip` (9%, 92% opaque), gold stays
for the primary action and the selected state. **NOT verified in the app:** the mock-up used the real token values, but no screenshot of the
running modal was taken.

**The lag.** `sync()` used to clone all 576 cells after every action, so Svelte re-proxied them and
re-evaluated every button. Now the engine's board is `$state.raw` (it mutates in place, so it cannot be
reactive anyway) and `commit()` replaces the board object for the HUD scalars. What a cell DRAWS lives in
`cellViews`: one immutable view per cell, replaced only when its code (state | mine | adjacent) differs
from the last drawn (`syncCellViews`, a compare of 576 integers and no cloning). The keyed list passes
each view to `MinesweeperCell`, whose props are compared by reference, so a flood re-renders the cells it
opened and none of the others. `moves` is a plain array. **Pinned:** `cellViews.test.ts` (a flag replaces
exactly one view, a second sync is a no-op), `settings.test.ts`, the stats/paging/long-press modal tests.
**Trap met on the way:** `startGame()` runs inside the open `$effect`; reading the raw `board` there made
the effect depend on it, and every later move reset the game - the board is read untracked there.
**NOT measured:** a before/after Performance profile on a phone, and how the gestures and the settings
feel - owed on the Mi 9T and the iPhone (`device-verification.md`).

## The Games page and the per-promo ranking (owner, 2026-11-10)

`/games` (`routes/games/+page.svelte`, a row of the dashboard's Explorer, open to every signed-in
account; the 5 taps on the settings title still open the game) carries **"Jouer"** (opens the same
`MinesweeperModal`), the reader's own record (`GET minesweeper/me`) and the ranking in two tabs: overall
and **per promo**. Moderation of scores is on this page for global admins (see the one-leaderboard section above).

- **Server**: `GET minesweeper/leaderboard?promo=<year>` narrows the board to one entry year, ranks
  counted inside it (`pu.promo = $1` through `users.promo`); a value that is not a year is a 400.
  `GET minesweeper/promos` answers `{ promos: [{ promo, players }], mine }` (newest first, `mine` = the
  caller's promo or `null`). **Only an account with a cursus appears in a promo ranking**: `users.promo`
  IS the cursus' entry year and the one column populated in production (`cursus->0->>'promo'` is NULL),
  so `promo IS NOT NULL` is the rule. **No migration**: both reads are over `minesweeper_scores` joined
  to `users`. Banned players and the other side of the review cohort stay out, as on the overall board.
- **Client**: the promo tab opens on the reader's own promo when it has a ranking, else the newest; a
  fresh load drops the answer of a tab or promo left behind (`generation`). The profile's
  "Demineur #16" badge links here, the time being only its tooltip.
- Proofs: `minesweeper.promo.integration.spec.ts` (REAL PostgreSQL, gated on `SOCIAL_IT_DATABASE_URL`:
  ranks counted inside a promo, a player without a promo absent, `mine`, the promo list with player
  counts, a banned player and a removed score excluded as in the global ranking), `minesweeper.promo.spec.ts`
  (the SQL's shape and parameters), `routes/games/page.svelte.test.ts`, `ProfileMinesweeperBadge.svelte.test.ts`.
- **Owed**: one read of the page on a phone with real scores in two promos.

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

The leaderboard now carries each row's `scoreId`, which is what "remove" names. In the
leaderboard sheet an admin gets a remove and a ban button per row, **each behind a confirmation**
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
seed X" needs the first click too, **and the generator**: since 2026-11-13 the same pair makes a
different board under generator 1 and generator 2 ([below](#generator-v2-owner-2026-11-13)).

**Generator 1** follows Simon Tatham's `mines.c`: place mines, run the solver, and while it is stuck
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

## Generation must not change, only get cheaper (per version)

The server replays a ranked game on the board regenerated from `(seed, first click)`, and a
challenge stays open for two hours. Any change to what the generator produces - a solver
deduction, the neighbor ORDER (it fixes constraint order, which feeds the RNG), an extra RNG draw
- rejects every challenge open at deploy time. The two copies are held identical by
`declared-duplicates.test.mjs`; the boards themselves by the fingerprint test in `game.test.ts`,
recorded before the 2026-09-24 speed-up.
**This holds per generator version, and a version is frozen**: generator 1 and generator 2 each have
their own fingerprint test, and a better generator is generator 3, never an edit of either.

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

## Generator v2 (owner, 2026-11-13)

*"l'algorithme de l'application a tendance a produire des grilles beaucoup plus interessantes en terme de
raisonnement requis pour les finir, j'aimerais me rapprocher de ca"* (owner), *"en gardant les contraintes de
random graine, avec l'aller-retour serveur"*. A board from generator 1 is as easy as its solver lets it be:
perturbation stops at the FIRST layout the solver clears. Measured on 300 boards, the reasoning score below
had a median of 11, a 90th percentile of 18 and a best of 27; the owner judged the two best "just enough".

**How it works** (`placeMinesV2` in `game.ts`). Start from a generator-1 layout the v2 solver clears, then
climb: swap ONE mine with ONE empty cell (never in the clicked 3x3), keep the swap when the board is still
clearable without guessing and its score did not fall, until the score reaches 60 or 300 swaps are spent.
The swaps are drawn from the board's RNG, so `(seed, first click, version)` still gives one board and the
server regenerates it. Two other ways of climbing were measured and dropped: swapping a mine with a nearby
cell gained nothing, and several swaps per evaluation was slower (and at five, reached 60 on 35 of 40 boards).

**The score.** The solver always takes the cheapest tier that makes progress and counts the deductions of
each tier above the chords: *subset* (one number's hidden cells inside another's - the 1-2 and 1-2-1
patterns), *local* (every assignment of one frontier component of up to 16 cells agrees), *global* (the
mines left overall, combined across ALL components and the unconstrained cells). Score = subset + 2 x local +
4 x global. The weights and the 16 are not derived from anything: they are what the scores the owner played
were measured with, so they ARE what "60" means.

**What the owner read** (a phone, 2026-11-13): 26 "interesting"; from 60 up "much more interesting"; 85 "not
too hard either". Hence a target of 60 and no ceiling. The play page, the boards and the ratings were a
throwaway rig outside the repository; nothing in it is needed to read this.

**Order independence, which the old solver lacked.** generator 1's solver uses the mine total only when the
whole frontier is ONE component, so what it clears depends on the order it takes steps in: the same
board was cleared by one order and left stuck by another on 11 boards in 100. The cause was found by
measuring it: not the count rule but the 16-cell enumeration cap - a frontier that grew into one 20-23-cell
component was never enumerated. v2 enumerates up to 40 cells, combines the components' counts with the mines
left (`globalTier`), and counts search nodes (200 000 per component, never a clock, so every machine stops at
the same place and the server reproduces the client). At a cap of 40 both orders cleared 100 boards of 100.
A whole generation has its own node budget (3 million: 72 000 at the median, 697 000 at the 99.9th percentile and
1.79 million at most over 600 boards), because no per-component cap bounds 300 swaps x several components each,
and the server runs this inside a `submit`; spent, enumerations are refused and the climb stops with the best
board it has. The enumerations are cached by the component's own constraints (dropped whole past 1000 entries).

**Measured** (the real generator, 600 boards, varied first clicks): 599 reach the target within the 300-swap
budget, none fall back, the swaps needed are 117 at the median, 178 at the 90th percentile and 231 at the
99th. The one that stops short is still clearable without guessing. First dig, workstation: median 102 ms,
90th percentile 161 ms, 99th 222 ms (generator 1: 14 / 46 / 51 ms). On a phone the climb (the part that
dominates) took a median of 267 ms and a 90th percentile of 390 ms in a back-to-back comparison against
the first implementation, which took 465 and 649; absolute phone numbers move with the device's heat (the same
code read 362-470 ms across runs), so only comparisons inside one run mean anything. Two optimisations, both
proven to leave every deduction unchanged (240 solves compared field by field): the chord tier re-reads only the
numbers next to a changed cell, and a component's enumeration is cached by its own constraints - valid across
swaps because it depends on nothing else. Tier 2 indexed by cell and swapping with nearby cells gained nothing.

**Versioning, and who may be ranked (owner, 2026-11-13: *"le classe devrait etre reserve aux clients avec la
derniere version du generateur"*).** The challenge carries `"generatorVersion"` (migration 170, `DEFAULT 1`, so
every challenge issued before it replays as generator 1). `POST /minesweeper/challenges` takes
`maxGeneratorVersion`, and **ranked is open only to a client that can make the server's latest generator**: a
time is comparable with another only on a board of the same difficulty, and letting an older build into the
same ranking would give it faster times for less reasoning. Any other client - including every build before
this one, which sends nothing - is refused `426` with `code: generator_update_required` and the latest
version, BEFORE its open challenge is expired. The screen reads the typed `MinesweeperUpdateRequiredError`,
says so (`minesweeper_update_required`) and plays an unranked game; it never reads a message. A challenge
already issued with generator 1 is still replayed with generator 1, for its two hours, and a stored version
the server does not know refuses the submit and says so (`unknown_generator`) rather than judging an honest
solve on another board - WITHOUT storing a rejection, so a server rolled back past a generator can retry it once rolled
forward. The engine throws on a version it does not know, and the client refuses one newer than it can make. The
replay hands back `generation`, and the service logs a warning when generator 2 fell back to an unproven layout. A casual (unranked) game uses the latest generator: nothing is submitted, so nothing
needs replaying ([legacy-compatibility](../../legacy-compatibility.md#a-tolerated-degradation-ranked-minesweeper-for-a-build-older-than-generator-2-owner-2026-11-13)).

**The ranking is reset (owner, 2026-11-14)**: the stored times were set on generator-1 boards, so they are dropped when the release carrying generator 2 reaches production - the owner's gesture ([the table](../../backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks)).

**What is open.** Generation is still synchronous on the main thread (the screen paints the pressed cell first);
a worker would keep the interface alive for the ~0.3 s a phone spends, and is not built. The one board in 600 that
stops short is unexplained beyond "the budget ended". The boards were rated on ONE phone, and the first
Challenge-sized game of a player who has only met generator 1 is the real reading
(written as a reading once generator 2 ships in a stable; [the worker](../../backlog.d/p3-minesweeper-generation-off-the-main-thread.md)).

## The replay: timed moves, and a moderator who can watch a win (owner, 2026-11-17)

*"register the timings of each action (place flags, mine) during each game, and send them to the server
(they should match the game length), and add a button to replay a game for the moderators, so they can
see if a game is legit"* (owner). The server's replay proved a log CLEARS the board; it said nothing of
HOW - a solver driving the real board, a pace no hand holds - and kept nothing to look at.

**Timestamps.** Every dig and flag the client logs carries `t`, whole milliseconds from the first dig
(`moveTime()` in the modal; the first move is 0, the timer starts right after it, so board generation is
not the player's time). `claimedDurationMs` is now the winning move's `t`, not the last 100 ms tick, and
the win clock shows that same number.

**What the server checks** (`timingsFault`, `minesweeper.timings.ts`, before the replay, a failure is a
400 and the challenge is stored as `rejected`): the first move is at 0, no move precedes the one before
it, and **the last `t` equals `claimedDurationMs`** - the log describes ONE game of the claimed length.
`t` is REQUIRED (no fallback for a client that omits it: ranked is already closed to a build that cannot
make generator 2, and generator 2 had not shipped in a stable, so no ranked client predates timings).
Nothing judges the PACE: whether it is humanly possible is the moderator's call, watching.

**What is kept.** A verified win stores its log in `minesweeper_replays` (migration 175): one row per
score, `moves jsonb` of `{type, x, y, t}`, `ON DELETE CASCADE` from the score - so removing a score, or an
account's erasure (which deletes its scores), removes the replay too (`account-erasure.ts` classifies
the column as holding no account id). Its own table because the leaderboard, the ranks and `me` read the
score on every request and a few hundred moves must not ride along. The BOARD is not stored: it is
regenerated from the challenge's seed, generator and size, as the server's replay does. Storing the log
is best-effort AFTER the score is saved: a failure is logged at `error` (a score with no replay cannot be
checked) and the player's win stands.

**The viewer.** `GET /minesweeper/scores/:scoreId/replay` returns the player's name, the recipe and the
log. **OPEN TO EVERY SIGNED-IN MEMBER** (owner, 2026-11-18: *"laisse tous les joueurs rejouer les scores
des autres"*), on the terms of the ranking it hangs off: a member may watch another player's BEST win (the one score the
ranking shows - an earlier win is not on offer, so a uuid from a stale client opens nothing) and any of their
own; a score the ranking hides - a banned player's, the other side of the review cohort's boundary - answers
404 to a member, as a score that does not exist; and a global admin (`X-Global-Admin`, read inline as every
controller of this service does) sees every score, because judging a cheat means opening a banned player's
game or an earlier win. A member's read is logged at `debug` (routine traffic); **an admin's at `log`**, since
it can reach what the ranking hides and the trace must survive in production. On the Games page every ranking row has a
"Revoir cette partie" button (admins also keep remove and ban); it opens `MinesweeperReplay.svelte`.

THE SCREEN IS THE BOARD (owner, 2026-11-18: the first window was too small for the grid on a phone): the
viewer is a full-screen sheet on a phone (`phoneFullScreen`), a tall dialog on a larger screen. The stage
takes every pixel the controls leave and **the whole grid is fitted to it** - `fitCellSize` picks the cell
size from the stage's measured room, re-fitted by a `ResizeObserver` on every resize or rotation, clamped
to 14-44 px (below 14 the cell's 12 px digit no longer fits) - so the grid is on screen whole. Its
padding and gap are DRAWN from the numbers the fit uses, and the grid is centred with `m-auto`, so a
stage too small for 14 px cells scrolls to the right and bottom instead of clipping its top and left. The
viewer honours the device's animation setting (`--ms-anim` on its root), as the game does. One bar under it: play / pause (the surface's primary action),
restart, the clock, a full-width scrubber, the move count with the last action (the cell it landed on is
ringed) and 1x / 2x / 4x / 8x. `replay.ts` rebuilds the board after any move: generation runs ONCE, up
front, the board right after the first move is copied, and going backwards restarts from that copy and
replays the few moves between. A 404 - a score removed, hidden from this member, never recorded, or
won before replays were kept - is said as "this game is not available": the client types the answer, not
the reason, and a wrong reason would be worse than none.

**The dig no longer fades when animations are off** (owner, 2026-11-18). `app.css` gives every `button`
a 180 ms colour crossfade in `@layer base`, and a cell is a button, so a dug cell faded from hidden to
revealed whatever the setting said (the setting scaled Tailwind's `--default-transition-duration`, which
that rule does not read). `MinesweeperCell` now takes the DURATION of its button from `--ms-anim`:
`calc(180ms * var(--ms-anim, 1))` - unchanged at normal speed, half at fast, zero at none.

**Charter.** Principle 1 (your messages are yours) is not touched - a game is not a message. The log is
shown to the members who already see the score on the ranking, and to nobody for a score the ranking hides;
the register (C28) names it, and it lives exactly as long as its score.

**Verified:** server specs for the timings (start, order, length), the stored log keeping its
timestamps, a failed store not failing the win, the replay read (and its 404s, and the trace of who
read it); client specs for the board after n moves forwards and backwards without regenerating, the
clock to move count, the viewer's states, the modal stamping a won game (moves from 0, non-decreasing,
claimed = last `t`) and the Games page button. **Read on dev 2026-11-18 (`1.7.0-alpha.12`):** migration 175
applied (the replay row stored with the score), and the first viewer as a real global admin at phone width
([readings](../../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)).

**Added 2026-11-18, after that reading (owner's three follow-ups):** specs for the button shown to a non-admin
too, who may read a replay (a member: any visible player's, their own; not a banned player's; an admin: all),
`fitCellSize`, and the cell's transition declaration. The full-screen viewer and the fitted grid were read on a
phone (2026-11-22, `1.7.3-alpha.6`); the computed transition is asserted with the component's own CSS injected (below).

**Pinned without a phone (2026-11-22, `1.7.3-alpha.6`).** The dig's crossfade follows the animation setting: the
mounted cell's computed `transition-duration` is 0 on "Aucune", 90 ms on "Rapide" and 180 ms normally
(`MinesweeperCell.svelte.test.ts`; the engine under test resolves the custom property but leaves `calc()`, so the
product is evaluated). A banned winner's game is the whole chain in `minesweeper.replay.spec.ts` (`a banned winner,
from the win to the replay`): a win is submitted, the winner banned through `ban()`, a global admin gets the moves and a
plain member a 404. The scrubber both ways and the refit on a stage change are `MinesweeperReplay.svelte.test.ts`.
