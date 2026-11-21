## Reading owed - Minesweeper replay and the instant dig, on a phone

target: 1.7.3

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

**What is built:** every ranked move is timed, the server keeps the log of a win (migration 175, `minesweeper_replays`), and every member replays it from the Games ranking ([minesweeper](../frontend/modules/minesweeper.md#the-replay-timed-moves-and-a-moderator-who-can-watch-a-win-owner-2026-11-17)); the cell's colour crossfade follows the animation setting.

**The reading that closes it:** on the `1.7.0` pre-release served on dev, on a phone: win a ranked game, open the Games ranking, press "Revoir cette partie" on it - the replay fills the screen, the WHOLE grid is visible at a readable size, the board plays back, the scrubber goes both ways, the speed buttons work, and a rotation refits the grid. With the animation setting on "Aucune", digging a cell must be instant - no fade - and with "Rapide" the fade is half as long. As a global admin, a banned player's game also opens. Migration 175 must have applied on dev first (the replay is stored only if the table exists; a missing table shows as `minesweeper replay not stored` at `error` in the social-service log, with the win still scored).
