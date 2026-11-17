## Reading owed - Minesweeper replay as a global admin

target: 1.7.0

**What is built:** every ranked move is timed, the server keeps the log of a win (migration 175, `minesweeper_replays`), and a global admin replays it from the Games ranking ([minesweeper](../frontend/modules/minesweeper.md#the-replay-timed-moves-and-a-moderator-who-can-watch-a-win-owner-2026-11-17)).

**The reading that closes it:** on the `1.7.0` pre-release served on dev, as a global admin on a phone: win a ranked game, open the Games ranking, press "Revoir cette partie" on it - the board plays back, the scrubber goes both ways, and the speed buttons work. Migration 175 must have applied on dev first (the replay is stored only if the table exists; a missing table shows as `minesweeper replay not stored` at `error` in the social-service log, with the win still scored).
