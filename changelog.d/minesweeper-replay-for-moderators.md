### Added - Minesweeper: every move is timed, and a moderator can replay a won game

Each dig and flag of a ranked game now carries the millisecond it was made, the server refuses a log that does not end where the claimed game does, and keeps the log with the score. A global admin gets a "Revoir cette partie" button on each row of the Games ranking: the board is rebuilt from the seed and the moves play back at their own pace, or faster. Details in [minesweeper](docs/wiki/frontend/modules/minesweeper.md#the-replay-timed-moves-and-a-moderator-who-can-watch-a-win-owner-2026-11-17).
