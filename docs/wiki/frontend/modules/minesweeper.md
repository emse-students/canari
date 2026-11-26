# Minesweeper

The easter-egg game in Settings: an 18x32 board with 150 mines (~26% density), generated so that
it can be cleared without guessing, with a ranked leaderboard checked by server-side replay.

| Piece | File |
| --- | --- |
| Engine (generation, solver, play, replay) | `frontend/src/lib/minesweeper/game.ts` |
| Server copy of the engine | `apps/social-service/src/minesweeper/engine/game.ts` |
| Screen (a full-screen PAGE at `/games/play`; the file keeps its historical `Modal` name and path, see below) | `frontend/src/lib/components/settings/MinesweeperModal.svelte`, `frontend/src/routes/games/play/+page.svelte` |
| THE leaderboard (ranking, promo, Stats, moderation) | `frontend/src/routes/games/+page.svelte`, `frontend/src/lib/components/games/MinesweeperStats.svelte` |
| View geometry (fit, bounds, zoom, flick) | `frontend/src/lib/minesweeper/view.ts` |
| Vibration patterns | `frontend/src/lib/minesweeper/haptics.ts` |
| Player settings (per device) | `frontend/src/lib/minesweeper/settings.ts` |
| Per-cell diff behind the render | `frontend/src/lib/minesweeper/cellViews.ts`, `MinesweeperCell.svelte` |
| The bulb of an unranked game (client only) | `frontend/src/lib/minesweeper/hint.ts` |
| The unranked levels (client only) | `frontend/src/lib/minesweeper/levels.ts` |
| The tutorial (page, lessons, mini-grid, shared reader) | `frontend/src/routes/games/tutorial/+page.svelte`, `frontend/src/lib/minesweeper/tutorial/lessons.ts`, `frontend/src/lib/components/games/MinesweeperMiniGrid.svelte`, `frontend/src/lib/components/games/MinesweeperLessonRunner.svelte` |
| The pattern catalogue, the tutorial's annex | `frontend/src/routes/games/tutorial/patterns/+page.svelte`, `frontend/src/lib/minesweeper/tutorial/patterns.ts` |
| Challenge issue, replay, scores | `apps/social-service/src/minesweeper/minesweeper.service.ts` |

## The screen is the board (2026-10-07)

*"affichage plein ecran, avec juste un bouton classement qui flotte en haut a droite"* and *"amelioration de
la fluidite et de la facilite de controle"* (user). The game has no title bar and no tabs. **It is a page, not a modal
(owner, 2026-11-25: the modal's portal, focus trap and history overlay cost frames a 576-cell board cannot
spare):** `/games/play` is a full-screen place (`isFullScreenPlace` in `lib/navigation/places.ts`, like the
camera), so the shell draws no header or bar and the page pads itself by the safe area. Leaving it is
navigation: the close and the trophy are `<a href="/games" data-back-link>`, so Back returns to the page the
player came from, and the game starts on mount and stops on destroy (it was an effect on an `open` flag).
**The component kept its name and path**: the raw-controls ratchet reads a moved file as a NEW entry, so a
rename of a file that carries raw controls cannot pass it. Everything else floats over the board:

| Control | Where | Notes |
| --- | --- | --- |
| Close, mines left, timer, restart | top left | the close is the only way out on iOS, which has no back gesture |
| Leaderboard | top right, trophy icon only | closes the game and goes to the Games page (`/games`), THE one leaderboard since 2026-11-13; the game has no sheet of its own |
| Game mode (ranked, or unranked at a level) | bottom, the pastille after dig / flag; a tap opens [the mode sheet](#the-mode-sheet-owner-2026-11-26) | **ONE choice of four** (owner, 2026-11-26): Classe, or Libre at Debutant / Intermediaire / Expert. **"Libre" = no challenge is requested at the first dig**, so nothing is submitted; stored in `canari.minesweeper.unranked` and `canari.minesweeper.level`; **locked once the first cell is dug** (the pastille then only reminds, without its chevron), since a game's ranking is decided when its board is generated |
| Mode (dig / flag) | bottom centre, thumb reach | what a SHORT press does; a long press does the other. Same stored setting as the old "flags first" |
| Hint (bulb) | bottom, after the pastille; dimmed until the first dig, which gives it a board to read | **unranked games only** ([below](#the-bulb-a-hint-in-an-unranked-game-owner-2026-11-25)) |

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
sheet had: each ranking row shows the date of the record (`verifiedAt` as `DD/MM/YY` through `shortDate`, the full `exactDate` in the tooltip, so
**no migration**: the date was already on the score row and in the leaderboard payload); the Stats
tab (`MinesweeperStats.svelte`, loaded when opened) shows ranked games played, wins, lost or
abandoned, win rate, rank, best, average and median time, the sparkline of the latest wins and their
dated list, and the "ranked games only" note; a global admin gets the remove-score and ban buttons
per row and the banned list with unban, each behind a confirmation. The settings sheet stays in the
game (it is about input, not ranking). Pinned by `page.svelte.test.ts`, `page.moderation.svelte.test.ts`,
`MinesweeperStats.svelte.test.ts`, `MinesweeperModal.chrome.svelte.test.ts`. The two sections below
describe the stats and paging mechanics, now on the page (page size 25, "Voir plus").

## Three levels in an unranked game (owner, 2026-11-25)

*"le demineur est vraiment super dur, la barriere a l'entree est terrifiante ... sans remettre en cause le niveau
du classe"* (owner), then *"priorise les difficultes par generation et pas par taille"*. Libre offers three
levels; **ranked is exactly as before** - the board, the generator, the challenge, the replay and the ranking
([decisions](../../decisions/owner-decisions-of-2026-11-25.md)).

**A LEVEL IS A GENERATION, NOT A SIZE.** Every level plays the ranked board (18x32, 150 mines) on generator 2 and
differs only by the reasoning score that generator climbs to (`targetScore`, [the climb](#generator-v2-owner-2026-11-13)).
The player never sees the number.

| Level | Target score | What the board is |
| --- | --- | --- |
| Debutant | 0 | the first layout the solver clears: guess-free, simple deductions (generator 1's scores were median 11) |
| Intermediaire | 30 | some subset and local reasoning on top (the owner called 26 "interesting") |
| Expert | 60 (`V2_TARGET_SCORE`) | the ranked board's target |

**How the target travels.** `MinesweeperBoard.targetScore` (default `V2_TARGET_SCORE`) is read by
`placeMinesV2` in place of the constant; `createBoard(config, seed, generator, targetScore)` sets it. **Ranked
never passes one**, and the server's `verifySolve` builds its board with the default, so a ranked board is the
one the server replays: pinned by "an explicit ranked target and the default are the same board" and by the
untouched fingerprints. The engine and its server copy changed together (the duplicate gate). A casual game
is never submitted, so its target is the client's alone. A higher target costs more climbing on the main
thread (bounded by the existing swap and node budgets; the worker stays the
[backlog entry](../../backlog.d/p3-minesweeper-generation-off-the-main-thread.md)).

**The levels are three of the four modes of [the mode sheet](#the-mode-sheet-owner-2026-11-26)** (`levels.ts`:
`PLAY_MODES`, `LEVEL_SPECS`). **The grid is the same at every level, so choosing one redraws nothing.** A ranked
start that fails and falls back to a casual game plays Expert's target.

**Stored per device** (`canari.minesweeper.level`, validated on read; a value that is not a level is logged and
ignored). With none stored, a player who already chose ranked or Libre on this device (`canari.minesweeper.unranked`
is set) starts on Expert, the board they knew; a newcomer starts on Debutant. **The default is answered ONCE and
stored** the moment it is resolved: asked again on a later open, it would read the Libre choice the newcomer
has just made and turn their Debutant into Expert (review of #4091; pinned across two modal mounts).

**Losing stays as it is**: no undo after a mine (owner's answer).

**Pinned:** `levels.test.ts` (every level on the ranked size and generator, Expert on the ranked target, targets
rising; three fixed seeds per level, each board naming its own target and guess-free, the mean score rising
from Debutant to Expert; the four modes and their order; a newcomer unranked, a stored choice kept; the level
default and a bad stored value), `game.test.ts` (an explicit ranked target equals the default, cell for cell;
target 0 stops before any swap), `MinesweeperModal.levels.svelte.test.ts` (a newcomer in Libre on Debutant;
a level pick redraws nothing and is stored; the mode locked after the first dig; each level generates with its
own target; a ranked game asks for its challenge as before and generates with the ranked target whatever Libre
last used). **Owed:** the phone
reading ([reading](../../backlog.d/reading-owed-the-minesweeper-hint.md)), and the first-dig time of Expert on
a phone, unchanged from ranked.

## The mode sheet (owner, 2026-11-26)

*"change le bouton de mode libre/classe ... propose moi des designs"* - four designs were proposed (a pastille
opening a sheet, a start screen on the grid, a four-segment bar, two stages) and the owner picked **the pastille
that opens a sheet**. The Classe / Libre toggle and the level chip that cycled without showing what it cycled
through were two controls for what is ONE choice, and a newcomer landed on the ranked board, the barrier to entry.

**The pastille** (the bottom bar, after dig / flag) wears the current mode: the trophy and "Classe", or a plant
that grows with the level (Debutant, Intermediaire, Expert) and its name, with a chevron while it can be opened.
**A tap opens the sheet** (`MinesweeperModeSheet.svelte`): a radio group of the four modes, each with a line on
what it is, the current one checked, a way to the tutorial, and Escape, the scrim or "Fermer" to leave. A pick is
stored (`canari.minesweeper.unranked`, and the level when it is a level) and the sheet closes. The names and lines
are `modeLabels.ts`, the list and the stored choices `levels.ts`.

**A newcomer plays Libre on Debutant** (owner, 2026-11-25: *"Libre + Debutant tant qu'aucune victoire"*): with no
stored choice `loadMinesweeperUnranked()` answers unranked, and ranked is one pick away - no hard lock. Nothing is
written until the player picks. **A player who always played ranked without ever touching the old toggle has no
stored choice either, so their first game after this change is Libre; one pick in the sheet brings back Classe
and is kept.**

**Locked after the first dig, as before**: the pastille is disabled once the board exists or while the first dig
waits for its challenge (the mode is being decided), and the sheet cannot be opened then. The bulb sits beside it
from the start in Libre, dimmed until there is a board to read.

**Pinned:** `MinesweeperModeSheet.svelte.test.ts` (the four modes in order, the current one checked, a pick
reaches the caller, the three ways out, the tutorial link), `MinesweeperModal.chrome.svelte.test.ts` (a newcomer in
Libre on Debutant and the mode locked after the first dig, the sheet and a remembered pick, a ranked pick asks for
its challenge), `MinesweeperModal.levels.svelte.test.ts`, `MinesweeperModal.hint.svelte.test.ts` (the pastille is
locked while the challenge is awaited). **Owed:** the phone reading
([reading](../../backlog.d/reading-owed-the-minesweeper-hint.md), items 7 and 13).

## The tutorial (owner, 2026-11-25)

*"une section tutoriel qui explique le fonctionnement du demineur avec des mini-grilles ... les regles, les
mecaniques de base, miner, poser un drapeau, mais aussi une partie plus avancee qui explique le chording, et
les patterns les plus courants (1-2-1, 1-2-2-1 etc.)"* (the patterns became the annex, below), and *"un bouton d'indications ... fais quelque chose de
vraiment explicatif, mais en montrant"* (owner). `/games/tutorial` is an ordinary page (it keeps the shell),
reached from the Games page and from the game's settings sheet.

**It is the real game in small.** A lesson's grid is a PICTURE in text (`tutorial/layout.ts`: `#` hidden mine,
`.` hidden safe, `F` a flag that is a premise, `0`-`8` a revealed number); `boardFromLayout` builds the engine's
own `MinesweeperBoard` with its mines placed, so the mini-grid plays on `revealCell`, `toggleFlag` and the chord
and draws with the game's own `MinesweeperCell` - what the tutorial teaches is what the game does. **A digit that
lies about its neighbours throws**, so a wrong picture cannot reach a player. Each grid shows **the mines counter**
as the game's HUD does (the mines minus the flags), so the lessons can teach it.

| # | Lesson | Teaches | Picture |
| --- | --- | --- | --- |
| 1 | Reveal | open a cell, what a number and a 0 mean (a gesture: the target is outlined in green from the start) | 5x4, hidden |
| 2 | Flag | a 1 with one hidden neighbour; Drapeau mode, right-click; the counter drops by one per flag and is **not** a proof | 3x3 |
| 3 | Automatic flags | a number whose mines left equal its hidden neighbours: **one tap flags them all** (the engine's chord does this before it opens) | 3x3 |
| 4 | Chording | a number with all its flags opens the rest in one tap (the flags are the premise) | 3x3 |
| 5 | The mines counter | a column of three 1s: the middle cell is the mine; **the counter then reads 0, so every other hidden cell is safe, the ones no number touches included** | 4x3 |

**The tutorial teaches the gestures and the rules, and NO pattern** (owner, 2026-11-26: *"les patterns specifiques ne
devraient pas etre enseignes direct, mais plutot rester dans l'onglet patterns"*). The 1-1, 1-2-1, 1-2-2-1 and the
two corners it first carried are the annex's: a lesson there is a reading of the board, and the tutorial's job is to
make a player able to play one. Its header and its closing screen lead to the catalogue.

**The highlights say what they are** (owner, 2026-11-26: *"surligne en rouge pour bombe sure, jaune pour groupe
de bombes (avec un seul rectangle qui englobe plusieurs cases) et vert pour safe"*). A step of the "Indice"
button rings the NUMBER(S) it reads (`highlight: 'read'` on `MinesweeperCell`, a dark ring, so it is never taken
for the yellow) and draws its marks as **one outline per rectangle over the grid, never a ring per cell**
(`MinesweeperMiniGrid.svelte`, placed in cells with `calc` on the shared `--ms-cell`, no measuring):

| Colour | Means | Badge |
| --- | --- | --- |
| red | a mine that is certain | none |
| yellow | a group of cells holding mines | the exact number of mines, when the numbers fix it |
| green | a cell that is certain to be safe | none |

A mark whose cells are not a rectangle (the five cells a corner number sees) is several rectangles with one
colour and ONE badge. A legend of the three colours shows with the hint. The step texts are authored, not
computed: a step explains a pattern, and the order a person reads it in is a teaching choice (the in-game bulb,
`hint.ts`, computes the next certain move on a real board instead).

**Every lesson AND every highlight is PROVED** (`tutorial/lessons.test.ts`), not read. The test enumerates every
arrangement of the hidden cells that the visible numbers allow, **with the mines counter's total**, and requires:
the cells a lesson asks to open are safe in all of them, the cells it asks to flag are mines in all of them, and
nothing the numbers force is left unasked - the goal IS what the picture forces. **A lesson that does not teach
the counter must not need it** (same answer with and without); the counter lesson must (the numbers alone force
strictly less). A red mark is a mine in every arrangement, a green mark is safe in every arrangement, a yellow
mark holds exactly the mines its badge says and is outlined because a lit number touches it, and no mark hides an
open cell. `lessonDone` also refuses a lucky flag beside the right ones: the point is the deduction.

**Pinned:** `layout.test.ts`, `lessons.test.ts`, `MinesweeperMiniGrid.svelte.test.ts` (tap, flag, right-click, a
chord in either mode, the automatic flags, the counter, a mine ends the lesson, solved ONCE, one outline per
rectangle and its colour and badge), `routes/games/tutorial/page.svelte.test.ts` (the lessons chain to a closing
screen that leads to a game, the hint cycle with its legend, restart, Back to `/games`).
**Owed:** the phone reading ([reading](../../backlog.d/reading-owed-the-minesweeper-hint.md), items 11 and 12).

## The pattern catalogue, the tutorial's annex (owner, 2026-11-26)

*"reprend leurs explications pour tous les patterns dans un tutoriel annexe"* (owner), after asking for an
introduction to REDUCED patterns *"sur les patterns de minesweeper.online"*. `/games/tutorial/patterns` lists
**every named pattern of that reference catalogue**, one playable board each, by family, reached from the
tutorial's header and closing screen. It shares the tutorial's reader (`MinesweeperLessonRunner.svelte`, which
the tutorial page also uses), with a jump list grouped by family.

**The source: the reference's own diagrams** (owner, 2026-11-26: *"tes exemples sont insuffisants, utilise ceux de
minesweeper.online tels quels en reprenant leurs explications, qui sont vraiment precises"*). The catalogue follows
the reference page entry by entry, **in its order and its families**: each board keeps the shape of the reference
diagram - which cells are open, which hidden, the flags, the cells the explanation groups - and each hint follows
its steps ("look at the left 1", "it touches the yellow cells, so they hold one mine", ...), one hint per step.
**The sentences are our own words** (French and English, from the statement of each step): the reference is a
third party's page, and its text is not copied into a public repository. The page is credited on the catalogue's
subtitle and here: <https://minesweeper.online/help/patterns>. The reference colours (yellow, purple, orange...) are
ONE colour here, the group colour; a step that speaks of two groups says where they are.

**What had to change, and is said in `patterns.ts`.** The reference diagrams are CROPS of larger boards, and drawn by
hand: a crop cuts the numbers at its edge (a 3 at the border of the picture sees cells that are not in it), and a
few are not consistent even with their own neighbours (one H3 number cannot be reached by any arrangement). So **an
entry keeps the reference's geometry and closes the crop's edges, and the numbers at a closed edge are recomputed from
the board** - the board the test proves is a real one. Three entries are not the reference's drawing:
the **introduction to reduction** (ours: the reference goes straight to the three reductions), and the **two
corner patterns**, whose boards are the open ones proved before (the reference's own pictures cannot hold the
numbers of their own explanation), turned to the reference's orientation (the 3 with a 1 on its left and a 1 below,
the corner above and to its right). The two last entries are full boards with a mines counter (**mine counting**,
**combinations**), as the reference draws them, and need it: the numbers alone force less.

**A catalogue entry is a WINDOW and says so with `partial: true`**: its picture holds more than the pattern asks, so
its goal is what the PATTERN concludes (the test holds it to be forced), not everything the neighbouring numbers
force. A tutorial lesson is exact: its goal IS everything forced.

**The corner patterns are OPEN, and a test holds them to it** (owner, 2026-11-26: *"la presence de bords permet de
contourner ce raisonnement"*). A first version drew the corner in a 4x4 grid whose edges made the ends of the arms
trivial: a 2 that sees only two hidden cells marks both, so the pattern was never needed. The lessons now sit in a
6x5 board whose right column is still hidden and touched by no number, and `lessons.test.ts` requires, for a
lesson that declares a `corner: { number, cell }`: **(1) no number of the picture settles its own neighbours** (a
0, or as many mines as hidden neighbours); **(2) the corner cell is forced WITH the corner number and unknown
WITHOUT it**, the mines counter included - the far column is what keeps the counter from standing in for the
reasoning (a closed 5x5 board always gave the answer without the corner number). The boards come from an
exhaustive solver over the small boards, the symmetric ones (1-3-1 reads 1-1-1-[3]-1-1-1, 2-2-2 is flanked by 1s).
**What each pattern forces in an open corner** (cells: X and Y at the ends of the arms, A B and D E the two pairs
shared with the corner number, C the outermost corner): 1-3-1 forces C a mine and X, Y safe; 2-2-2 forces C safe
and X, Y mines, and both leave one mine in each pair for the other numbers to place. Neither needs the counter.


| Family (the reference's) | Entries |
| --- | --- |
| Basic patterns | B1, B2, 1-1, 1-1+, 1-2, 1-2+, 1-2C, 1-2C+, 1-2-1, 1-2-2-1 |
| Reduction | the introduction (ours), 1-1R, 1-2R, 1-2-1R |
| Holes | H1, H2, H3 |
| Triangles | T1, T2, T3, T4, T5 |
| High complexity patterns | 1-3-1 and 2-2-2 at an open corner, 1>2<1, the T pattern, the dependency chain |
| Last turns | mine counting, combinations |

**Reduction** (the owner's request): a number minus the flags it touches is what is left to find among the
hidden cells WITHOUT a flag, so the classic pattern applies as it is (a 2 beside one flag is a 1, a 4 beside
three is a 1). A hint step can carry `reduced: [{ cell, value }]`, drawn as a `-> n` pill on the number, and
the test holds each label to the board: **the digit minus its flagged neighbours, on a number the step is
reading**. The introduction reduces to the B1 pattern, then the three entries reduce to 1-1, 1-2 and 1-2-1.

**Open grids** (owner, 2026-11-26: *"une continuite avec des cases non importantes, un nombre inconnu de mines
et des pointilles qui continuent la grille"*): a pattern is local, and a small picture carries a mines total that
can decide cells the pattern does not, so a lesson with `open: true` is a WINDOW on a larger board. Its hidden
cells that no revealed number touches are the continuation: drawn dotted and faded (`MinesweeperCell`
`highlight: 'far'`), not playable (a tap on one is ignored, it could be a mine), the counter reads "?", and the
proof leaves the total out. The counter lessons (the counter, combinations) stay closed: the total is their
subject. This replaced a search for boards on which the counter never decides.

**Pinned:** `lessons.test.ts` (the whole catalogue, with the tutorial: goals, highlights, the counter's role,
the reduction labels, the list of reference names, the families kept together), `MinesweeperMiniGrid.svelte.test.ts`
(an open grid, a reduction label), `routes/games/tutorial/patterns/page.svelte.test.ts`. **Owed:** the phone
reading ([reading](../../backlog.d/reading-owed-the-minesweeper-hint.md), item 14).

## The bulb: a hint in an unranked game (owner, 2026-11-25)

*"En mode non classe (libre), j'aimerais bien qu'on puisse avoir un peu de didacticiel pour s'entrainer ...
indiquer une des cases chiffrees qui donne le prochain coup ? Sans donner la reponse, cela oriente le regard."*
(owner). A `Lightbulb` chip beside the mode button; a press lights WHAT JUSTIFIES the next certain move, never
the move, with one line saying what is lit. The next move (or a new board) clears it.

**The owner's four decisions (2026-11-25, [decisions](../../decisions/owner-decisions-of-2026-11-25.md)):**

1. **The numbers that justify the deduction, as few as suffice**: ONE number when it settles its neighbours alone
   (a chord), the TWO of a pair pattern, else the smallest group found. Never the cell to play.
2. **A wrong flag comes first**: a flag on a cell with no mine is ringed in red and said to be misplaced.
3. **When only the total decides**, the mines-left counter in the HUD is ringed.
4. **Unranked only.** A ranked game draws no bulb, and `showHint()` refuses (a `warn`) outside one; nothing
   enters the move log, so nothing the server replays changes. The bulb is offered when the player chose
   "Libre" before the first dig, or when a started game holds no challenge (a ranked start that failed).

**How it finds the hint** (`findHint`, pure, read-only). It reads what the PLAYER sees - revealed numbers,
flags, the mine total - so what it points at is a deduction a player could make. The hidden layout is read for
one question only: is a flag on a mine (decision 2). No visible state can prove that, and once every flag is
known right, every count the numbers still need is exact - a "contradictory visible state" can only come from a
wrong flag, so it is caught there. Then the cheapest explanation, in a fixed order (same state, same hint):

| Tier | Lights | What it is |
| --- | --- | --- |
| wrong flag | that flag (the first in reading order) | decision 2 |
| single | one number | its hidden neighbours are all safe, or all mines |
| pair | two numbers sharing a hidden neighbour | they settle a cell together (1-2, 1-2-1 and their kin; the generator's *subset* tier is a special case) |
| group | the fewest numbers found | one group of linked numbers settles a cell, ignoring the total |
| counter | the HUD's mines left | only the total settles a cell (the generator's *global* tier) |
| none | nothing; "no certain move was found" | logged: a `warn` when the search was complete (a no-guess board never gets there), an `info` when it ran out of budget |

Within a tier, a deduction that OPENS a cell is preferred to one that flags a mine. **The group is minimal, not
minimum**: rings of numbers grow around the settled cell until they settle it (adding a number never unsettles a
cell), then every number the deduction holds without is dropped in reading order. Finding the true minimum means
trying every subset; this gives a set where no number can be removed, cheaply, and every set it keeps is a valid
hint - so a budget spent midway leaves a true hint, only a larger one. Bounded by COUNTED search nodes (200 000
per enumeration, 2 million per hint), never a clock.

**Why it does not call the engine's solver.** `game.ts` is held identical to the server's copy and frozen per
generator; its helpers are private, and its tiers MUTATE the board they solve (they flag and open as they go).
Exporting them would be an edit of a frozen file for no gain. So `hint.ts` re-expresses the same enumeration
over the visible state (a depth-first search that cuts a branch as soon as one number cannot be met, the counts
combined across groups and "the sea" exactly as `globalTier` does) and imports only the board's TYPE. Nothing in
it can change a board, a replay or a fingerprint.

**The render.** A lit cell gets a ring in a token colour (`accent`, `red-err` for a wrong flag) and a glow that
breathes at `--ms-anim` - a `filter`, since Tailwind draws the ring with `box-shadow`; at "Aucune" only the ring
stays. Each cell reads `highlight` as a primitive, so a hint re-renders the few cells it lights, as `pending`
does, and the 576 views are untouched. One ring per cell: the hint wins over the replay viewer's `marked` ring. For a screen reader a lit cell is labelled ("2, indice", "Drapeau mal place" through Paraglide), the ringed counter carries a hidden "(indice)", and the message line is a `role="status"` region that stays mounted, empty, so its first message is announced. **Fixed on the way:** the Classe / Libre toggle was still live while the first dig waited for its challenge; it is locked then too.

**Charter.** Principle 3 (your attention is not for sale): the bulb is asked for, never offered by a prompt, and
it explains itself in one line. Principle 7 (simple): one control, in the mode nothing ranks.

**Measured** (a throwaway script, 20 generated boards played through by revealing around each lit number, 5 537
hints on a workstation): 0.03 ms on average, 1.6 ms at most; never "none". **Pinned:** `hint.test.ts` (each
tier on a hand-drawn board, safe preferred, the wrong flag first, nothing on a 50/50, determinism, the board
untouched, a real generator-2 board), `MinesweeperModal.hint.svelte.test.ts` (no bulb ranked, the cells and the
counter lit, the highlight cleared by the next move). **Owed:** one reading on a phone
([reading](../../backlog.d/reading-owed-the-minesweeper-hint.md)).

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
account; the 5 taps on the settings title still open the game) carries **"Jouer"** (a link to `/games/play`), the reader's own record (`GET minesweeper/me`) and the ranking in two tabs: overall
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
"Revoir cette partie" button (admins also keep remove and ban); it is a link to `/games/replay/<scoreId>`, a full-screen page like the game (`MinesweeperReplay.svelte`).

THE SCREEN IS THE BOARD (owner, 2026-11-18: the first window was too small for the grid on a phone): the
viewer is a full-screen PAGE (`/games/replay/[id]`, since 2026-11-25; it was a modal), with a header
whose arrow is a Back link. The stage
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
