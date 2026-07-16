import { describe, expect, it } from 'vitest';
import {
  createBoard,
  revealCell,
  toggleFlag,
  runAutoAssists,
  isSolvableWithoutGuessing,
  BEGINNER,
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
  it('creates a beginner board with hidden cells', () => {
    const board = createBoard();
    expect(board.width).toBe(9);
    expect(board.mineCount).toBe(10);
    expect(board.cells.every((c) => c.state === 'hidden')).toBe(true);
  });

  it('first reveal places mines and never detonates the clicked cell', () => {
    const board = createBoard({ width: 5, height: 5, mineCount: 5 });
    revealCell(board, 2, 2);
    expect(board.minesPlaced).toBe(true);
    expect(cellAt(board, 2, 2).mine).toBe(false);
    expect(cellAt(board, 2, 2).state).toBe('revealed');
    expect(board.status).not.toBe('lost');
  });

  it('toggles flags and counts them', () => {
    const board = createBoard({ width: 3, height: 3, mineCount: 1 });
    toggleFlag(board, 0, 0);
    expect(cellAt(board, 0, 0).state).toBe('flagged');
    expect(board.flagCount).toBe(1);
    toggleFlag(board, 0, 0);
    expect(cellAt(board, 0, 0).state).toBe('hidden');
    expect(board.flagCount).toBe(0);
  });

  it('auto-flags when hidden neighbors equal remaining mines', () => {
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

  it('auto-reveals when flags match the number', () => {
    const board = makeBoard(3, 3, [[0, 0]]);
    for (const c of board.cells) c.state = 'hidden';
    cellAt(board, 1, 1).state = 'revealed';
    board.revealedCount = 1;
    cellAt(board, 0, 0).state = 'flagged';
    board.flagCount = 1;
    runAutoAssists(board);
    expect(cellAt(board, 2, 2).state).toBe('revealed');
    expect(board.status).toBe('won');
  });

  it('loses when revealing a mine', () => {
    const board = makeBoard(2, 2, [[0, 0]]);
    board.minesPlaced = true;
    revealCell(board, 0, 0);
    expect(board.status).toBe('lost');
    expect(cellAt(board, 0, 0).state).toBe('revealed');
  });

  it('generates beginner boards that are solvable without guessing', () => {
    for (let i = 0; i < 30; i++) {
      const board = createBoard(BEGINNER);
      const startX = 4;
      const startY = 4;
      revealCell(board, startX, startY);
      expect(board.minesPlaced).toBe(true);
      expect(board.status).not.toBe('lost');
      const startIndex = startY * board.width + startX;
      expect(isSolvableWithoutGuessing(board, startIndex)).toBe(true);
      runAutoAssists(board);
      expect(board.status).toBe('won');
    }
  });

  it('detects a layout that still requires a guess after the opening', () => {
    // 2x2 with a single corner mine: opening the opposite corner reveals a "1"
    // touching three unknowns with one mine → no forced cell (classic guess).
    const board = makeBoard(2, 2, [[0, 0]]);
    expect(isSolvableWithoutGuessing(board, 3)).toBe(false);
  });
});
