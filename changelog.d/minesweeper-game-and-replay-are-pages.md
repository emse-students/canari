### Changed - the Minesweeper and its replay are full-screen pages, not modals

`/games/play` and `/games/replay/<id>` are routes: no portal, focus trap or history overlay around a
576-cell board, Back returns to the page the player came from, and "Jouer" and the replay buttons are
links ([minesweeper](docs/wiki/frontend/modules/minesweeper.md#the-screen-is-the-board-2026-10-07)).
