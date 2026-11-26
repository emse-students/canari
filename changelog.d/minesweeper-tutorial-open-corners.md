### Fixed - the Minesweeper tutorial's 1-3-1 and 2-2-2 corner lessons no longer let a board edge skip the pattern

They now sit in an open corner where no number settles its cells alone and the corner number is the only way to
decide the corner cell, which a test enforces; the 2-2-2 teaches that its outermost corner is safe and the two
cells at the ends of the arms are mines
([tutorial](docs/wiki/frontend/modules/minesweeper.md#the-tutorial-owner-2026-11-25)).
