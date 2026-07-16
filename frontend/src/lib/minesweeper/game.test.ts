import { describe, expect, it } from 'vitest';
import {
  createBoard,
  revealCell,
  toggleFlag,
  chordCell,
  runAutoAssists,
  isSolvableWithoutGuessing,
  verifySolve,
  DEFAULT_CONFIG,
  CHALLENGE,
  type MinesweeperBoard,
  type Cell,
} from './game';

function makeBoard(
  width: number,
  height: number,
  minePositions: Array<[number, number]>
): MinesweeperBoard {
  const board = createBoard({ width, height, mineCount: minePositions.length });
  board.minesPlaced = true;
  for (const [x, y] of minePositions) {
    board.cells[y * width + x].mine = true;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (board.cells[i].mine) continue;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (board.cells[ny * width + nx].mine) count++;
        }
      }
      board.cells[i].adjacent = count;
    }
  }
  return board;
}

function cellAt(board: MinesweeperBoard, x: number, y: number): Cell {
  return board.cells[y * board.width + x];
}

describe('minesweeper', () => {
  it('defaults to the 18x32 / 150-mine challenge board', () => {
    const board = createBoard();
    expect(board.width).toBe(18);
    expect(board.height).toBe(32);
    expect(board.mineCount).toBe(150);
    expect(DEFAULT_CONFIG).toEqual(CHALLENGE);
  });

  it('first reveal places mines and never detonates the clicked cell', () => {
    const board = createBoard({ width: 5, height: 5, mineCount: 5 });
    revealCell(board, 2, 2);
    expect(board.minesPlaced).toBe(true);
    expect(cellAt(board, 2, 2).mine).toBe(false);
    expect(cellAt(board, 2, 2).state).toBe('revealed');
    expect(board.status).not.toBe('lost');
  });

  it('toggles flags and does not auto-open after flagging', () => {
    const board = makeBoard(3, 3, [[0, 0]]);
    for (const c of board.cells) c.state = 'hidden';
    cellAt(board, 1, 1).state = 'revealed';
    board.revealedCount = 1;
    for (const [x, y] of [
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 2],
      [2, 0],
      [2, 1],
      [2, 2],
    ] as const) {
      cellAt(board, x, y).state = 'revealed';
      board.revealedCount++;
    }
    // Only the mine at (0,0) is still hidden; flagging it must NOT auto-open/win.
    toggleFlag(board, 0, 0);
    expect(cellAt(board, 0, 0).state).toBe('flagged');
    expect(board.status).toBe('playing');
  });

  it('does not auto-flag after digging; flags only when clicking the number', () => {
    // Mines at top corners. Digging (1,0) must leave mines hidden until the number is clicked.
    const board = makeBoard(3, 3, [
      [0, 0],
      [2, 0],
    ]);
    for (const c of board.cells) c.state = 'hidden';
    for (const [x, y] of [
      [0, 1],
      [1, 1],
      [2, 1],
      [0, 2],
      [2, 2],
    ] as const) {
      cellAt(board, x, y).state = 'revealed';
      board.revealedCount++;
    }
    revealCell(board, 1, 0);
    expect(cellAt(board, 1, 0).state).toBe('revealed');
    expect(cellAt(board, 0, 0).state).toBe('hidden');
    expect(cellAt(board, 2, 0).state).toBe('hidden');

    // Click the number → places both flags.
    revealCell(board, 1, 0);
    expect(cellAt(board, 0, 0).state).toBe('flagged');
    expect(cellAt(board, 2, 0).state).toBe('flagged');
    expect(cellAt(board, 1, 2).state).toBe('hidden');
    expect(board.status).toBe('playing');
  });

  it('clicking a number flags when hidden count matches, else opens when flags match', () => {
    const board = makeBoard(3, 3, [
      [0, 0],
      [2, 0],
    ]);
    for (const c of board.cells) c.state = 'hidden';
    for (const [x, y] of [
      [0, 1],
      [1, 0],
      [1, 1],
      [2, 1],
      [0, 2],
      [1, 2],
      [2, 2],
    ] as const) {
      cellAt(board, x, y).state = 'revealed';
      board.revealedCount++;
    }
    // (1,0) shows 2 with exactly two hidden neighbors → click places flags only.
    revealCell(board, 1, 0);
    expect(cellAt(board, 0, 0).state).toBe('flagged');
    expect(cellAt(board, 2, 0).state).toBe('flagged');
    expect(board.status).toBe('playing');

    // Fresh board: flags already match → click opens the rest.
    const board2 = makeBoard(3, 3, [[0, 0]]);
    for (const c of board2.cells) c.state = 'hidden';
    cellAt(board2, 1, 1).state = 'revealed';
    board2.revealedCount = 1;
    cellAt(board2, 0, 0).state = 'flagged';
    board2.flagCount = 1;
    revealCell(board2, 1, 1);
    expect(cellAt(board2, 2, 2).state).toBe('revealed');
    expect(board2.status).toBe('won');
  });

  it('manual chord opens neighbors when flags match the number', () => {
    const board = makeBoard(3, 3, [[0, 0]]);
    for (const c of board.cells) c.state = 'hidden';
    cellAt(board, 1, 1).state = 'revealed';
    board.revealedCount = 1;
    cellAt(board, 0, 0).state = 'flagged';
    board.flagCount = 1;
    chordCell(board, 1, 1);
    expect(cellAt(board, 2, 2).state).toBe('revealed');
    expect(board.status).toBe('won');
  });

  it('manual chord does nothing when flags do not match', () => {
    const board = makeBoard(3, 3, [[0, 0]]);
    for (const c of board.cells) c.state = 'hidden';
    cellAt(board, 1, 1).state = 'revealed';
    board.revealedCount = 1;
    chordCell(board, 1, 1);
    expect(cellAt(board, 0, 0).state).toBe('hidden');
    expect(board.status).toBe('playing');
  });

  it('solver auto-assists still clear a trivial endgame (generation path)', () => {
    const board = makeBoard(3, 3, [[0, 0]]);
    for (const c of board.cells) c.state = 'hidden';
    cellAt(board, 1, 1).state = 'revealed';
    board.revealedCount = 1;
    for (const [x, y] of [
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 2],
      [2, 0],
      [2, 1],
      [2, 2],
    ] as const) {
      cellAt(board, x, y).state = 'revealed';
      board.revealedCount++;
    }
    runAutoAssists(board);
    expect(cellAt(board, 0, 0).state).toBe('flagged');
    expect(board.status).toBe('won');
  });

  it('loses when revealing a mine', () => {
    const board = makeBoard(2, 2, [[0, 0]]);
    board.minesPlaced = true;
    revealCell(board, 0, 0);
    expect(board.status).toBe('lost');
    expect(cellAt(board, 0, 0).state).toBe('revealed');
  });

  it('generates challenge boards that are solvable without guessing', () => {
    const board = createBoard(CHALLENGE);
    const startX = 9;
    const startY = 16;
    const t0 = Date.now();
    revealCell(board, startX, startY);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(board.minesPlaced).toBe(true);
    expect(board.status).not.toBe('lost');
    const startIndex = startY * board.width + startX;
    expect(isSolvableWithoutGuessing(board, startIndex)).toBe(true);
    runAutoAssists(board);
    expect(board.status).toBe('won');
  }, 30_000);

  it('detects a layout that still requires a guess after the opening', () => {
    const board = makeBoard(2, 2, [[0, 0]]);
    expect(isSolvableWithoutGuessing(board, 3)).toBe(false);
  });

  it('seeded generation is deterministic for the same first click', () => {
    const seed = 'ranked-fixture-seed-001';
    const a = createBoard({ width: 9, height: 9, mineCount: 10 }, seed);
    const b = createBoard({ width: 9, height: 9, mineCount: 10 }, seed);
    revealCell(a, 4, 4);
    revealCell(b, 4, 4);
    expect(a.cells.map((c) => (c.mine ? 1 : 0)).join('')).toBe(
      b.cells.map((c) => (c.mine ? 1 : 0)).join('')
    );
  });

  it('verifySolve rejects empty or incomplete move lists', () => {
    expect(verifySolve('seed', []).ok).toBe(false);
    expect(verifySolve('seed', [{ type: 'flag', x: 0, y: 0 }]).ok).toBe(false);
  });
});
