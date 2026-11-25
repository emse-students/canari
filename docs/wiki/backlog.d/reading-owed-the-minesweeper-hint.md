## Reading owed - the Minesweeper levels and bulb read well on a phone (2026-11-25)

target: 1.8.2

_The bulb and the levels ship in 1.8.2 (owner, 2026-11-25); moved to 1.8.2 when 1.8.1 shipped._

**Built and tested in jsdom, never seen on a device** ([bulb](../frontend/modules/minesweeper.md#the-bulb-a-hint-in-an-unranked-game-owner-2026-11-25), [levels](../frontend/modules/minesweeper.md#three-levels-in-an-unranked-game-owner-2026-11-25); owner decisions of 2026-11-25, items 6 and 7). What the hint DEDUCES is pinned by `hint.test.ts`; what no gate here sees is how the highlight reads on a real board.

**What to read, on the Mi 9T and the iPhone 12** (a build carrying this change, Settings > the Minesweeper):

1. **Ranked has no bulb**: with "Classé" selected, no bulb before the first dig nor during the game.
2. **Libre has one**: switch to "Libre", dig. The bulb is dimmed before the first dig, live after it. A press rings one number (or two, or a few) and the line under the board says so; the ring is findable at the fitted zoom, and the glow breathes (none at "Aucune" animations, only the ring).
3. **The highlight is the reason, not the move**: on a few presses, the lit numbers really do settle a cell, and no hidden cell is lit.
4. **A wrong flag**: flag a cell that is clearly safe, press the bulb: that flag is ringed in red and the line says it is misplaced.
5. **The counter**: near the end of a game, when only the total decides, the HUD's mines left is ringed.
6. **The next move clears it**: dig or flag anything; the ring and the line go.
7. **The levels**: in Libre, the level chip cycles Debutant -> Intermediaire -> Expert and the blank board follows (9x9, 16x16, 18x32), fitted with cells of a sensible size (not tiles); a Debutant game can be finished without guessing; once dug, the chip is gone and the bulb is there; on Debutant the counter starts at 10 and the bulb works.
8. **Ranked unchanged**: back to "Classé", the board is 18x32 and the game is ranked (the trophy in the HUD), whatever level Libre last used.

**What closes it**: items 1, 2, 4, 6, 7 and 8 pass on both phones, and item 3 holds on at least five presses. A failure names the item.
