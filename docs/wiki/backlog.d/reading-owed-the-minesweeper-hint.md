## Reading owed - the Minesweeper pages, levels, bulb and tutorial read well on a phone (2026-11-25)

target: 1.8.2

_The bulb and the levels ship in 1.8.2 (owner, 2026-11-25); moved to 1.8.2 when 1.8.1 shipped. The same day the owner moved the levels from sizes to generations, made the game and its replay full-screen pages, and asked for a tutorial: their readings are items 9 to 12._

**Built and tested in jsdom, never seen on a device** ([bulb](../frontend/modules/minesweeper.md#the-bulb-a-hint-in-an-unranked-game-owner-2026-11-25), [levels](../frontend/modules/minesweeper.md#three-levels-in-an-unranked-game-owner-2026-11-25); owner decisions of 2026-11-25, items 6 and 7). What the hint DEDUCES is pinned by `hint.test.ts`; what no gate here sees is how the highlight reads on a real board.

**What to read, on the Mi 9T and the iPhone 12** (a build carrying this change, Settings > the Minesweeper):

1. **Ranked has no bulb**: with "Classé" selected, no bulb before the first dig nor during the game.
2. **Libre has one**: switch to "Libre", dig. The bulb is dimmed before the first dig, live after it. A press rings one number (or two, or a few) and the line under the board says so; the ring is findable at the fitted zoom, and the glow breathes (none at "Aucune" animations, only the ring).
3. **The highlight is the reason, not the move**: on a few presses, the lit numbers really do settle a cell, and no hidden cell is lit.
4. **A wrong flag**: flag a cell that is clearly safe, press the bulb: that flag is ringed in red and the line says it is misplaced.
5. **The counter**: near the end of a game, when only the total decides, the HUD's mines left is ringed.
6. **The next move clears it**: dig or flag anything; the ring and the line go.
7. **The levels (by generation, not size)**: the pastille in the bottom bar names the mode (a newcomer lands on "Debutant", not on the ranked game) and a tap opens the sheet of four; picking a level leaves the board the SAME 18x32 (nothing redraws); a Debutant game can be finished without guessing, and its deductions are plainly simpler than Expert's; the first dig of Expert takes no longer than a ranked one; once dug, the pastille only reminds (no chevron, no sheet) and the bulb is live; the counter starts at 150 at every level and the bulb works.
8. **Ranked unchanged**: pick "Classe" in the sheet, the pastille shows the trophy, the board is 18x32 and the game is ranked (the trophy in the HUD), whatever level Libre last used; there is no bulb.
9. **The game is a page** ([pages](../frontend/modules/minesweeper.md#the-screen-is-the-board-2026-10-07)): "Jouer" opens `/games/play` with no header or bar; the board and the floating controls clear the notch and the home bar in portrait AND landscape; the Android Back gesture and the iPhone's close button return to the Games page; a long game pans and zooms as smoothly as before, or better.
10. **The replay is a page**: a ranking row's replay opens `/games/replay/<id>` full screen with its Back arrow; the grid is fitted whole and the controls clear the home bar.
11. **The tutorial**: from "Tutoriel" on the Games page (and the game's settings sheet), the five lessons (reveal, flag, automatic flags, chord, counter - no pattern) play on a phone: cells are a comfortable thumb size, the mode buttons switch dig and flag, a flag is placed and the mines counter above the grid drops, a tap on the 2 of the automatic-flags lesson flags both mines, the chord opens its two cells, the counter lesson ends with the rest opened after the flag, and a mine says so with "Recommencer" offered.
12. **The highlights read**: with "Indice", the number being read is ringed in the text colour, a certain mine is ONE red rectangle, a group is ONE yellow rectangle with its mine count in a badge, a certain safe cell is green, the legend names the three; in the catalogue (`/games/tutorial/patterns`), on the 1-2-1, the 1-2-2-1 and the two open-corner entries (1-3-1, 2-2-2, a 6x5 grid that must fit a phone width without scrolling) each step is legible on both themes and the sentence under the grid matches what is outlined.

13. **The mode sheet reads**: on both phones the sheet rises from the bottom without covering the home bar, its four rows are tall enough for a thumb and legible on both themes, each line says what the mode is, the pastille is not clipped on a 360 px screen with "Intermediaire", and the sheet closes on the scrim, on "Fermer" and on the Android Back gesture without leaving the game.

14. **The pattern catalogue reads** (`/games/tutorial/patterns`, from the tutorial's header): the jump list opens and groups the 29 entries by family; an open grid shows its dotted continuation and a "?" counter, and a tap on a dotted cell does nothing; the reduction entries draw their `-> n` pills on the right numbers; the tall ones (the dependency chain, ten rows; mine counting, ten rows with its counter) fit a phone height without hiding the hint, and the sentence under each grid matches what is outlined.

**What closes it**: items 1, 2, 4, 6, 7, 8, 9, 11, 13 and 14 pass on both phones, item 3 holds on at least five presses, and items 10 and 12 pass on at least one. A failure names the item.
