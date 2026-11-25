/**
 * The bulb of an unranked game (owner, 2026-11-25): which numbers justify the next certain move, a
 * misplaced flag, the mines-left counter when only the total decides, and "nothing" - over boards
 * drawn by hand so each case is the one the test names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBoard, revealCell, CHALLENGE, type MinesweeperBoard } from './game';
import { findHint } from './hint';

/**
 * A board from rows of characters: `o` revealed, `.` hidden safe, `*` hidden mine, `F` a flag on a
 * mine, `f` a flag on a safe cell. Numbers are computed; the mine total is the mines drawn.
 */
function board(rows: string[]): MinesweeperBoard {
  const height = rows.length;
  const width = rows[0].length;
  const b = createBoard({ width, height, mineCount: 1 }, null, 2);
  let mines = 0;
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const cell = b.cells[y * width + x];
      cell.mine = ch === '*' || ch === 'F';
      if (cell.mine) mines++;
      cell.state = ch === 'o' ? 'revealed' : ch === 'F' || ch === 'f' ? 'flagged' : 'hidden';
    })
  );
  b.cells.forEach((cell, i) => {
    const x = i % width;
    const y = Math.floor(i / width);
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < width && ny < height) {
          if (b.cells[ny * width + nx].mine) n++;
        }
      }
    }
    cell.adjacent = n;
  });
  b.mineCount = mines;
  b.minesPlaced = true;
  b.revealedCount = b.cells.filter((c) => c.state === 'revealed').length;
  b.flagCount = b.cells.filter((c) => c.state === 'flagged').length;
  return b;
}

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('findHint', () => {
  it('points at ONE number when it settles its neighbours alone', () => {
    // The 1 at 0 touches one hidden cell: a mine.
    expect(findHint(board(['o*']))).toEqual({ kind: 'numbers', tier: 'single', cells: [0] });
  });

  it('prefers a number that opens a cell to one that flags a mine', () => {
    // 0 and 2 each settle a mine; the 1 at 4 already has its flag, so 5 opens.
    expect(findHint(board(['o*oFo.']))).toEqual({ kind: 'numbers', tier: 'single', cells: [4] });
  });

  it('points at the TWO numbers of a subset pattern, and never at the cell to play', () => {
    // 1 over {3,4}, 1 over {3,4,5}: 5 is safe, from both numbers together.
    const hint = findHint(board(['ooo', '.*.']));
    expect(hint).toEqual({ kind: 'numbers', tier: 'pair', cells: [0, 1] });
  });

  it('points at the smallest group of numbers when no pair suffices', () => {
    // 2 over {0,2,5,6}, 1 over {0,5,8,9}, 1 over {5,6,7,9,11}: 9 is safe, from all three only.
    const hint = findHint(board(['.o**', 'o*..', '..o.']));
    expect(hint).toEqual({ kind: 'numbers', tier: 'group', cells: [1, 4, 10] });
  });

  it('points at the mines-left counter when only the total decides', () => {
    // The 1 splits one mine between 0 and 2; with one mine in all, 3 (touched by no number) is safe.
    expect(findHint(board(['*o..']))).toEqual({ kind: 'counter' });
  });

  it('shows a misplaced flag before any deduction', () => {
    // The flag at 1 stands on no mine; the 1 at 2 could otherwise be read.
    expect(findHint(board(['ofo*']))).toEqual({ kind: 'wrong-flag', cell: 1 });
  });

  it('says when nothing is certain, and accuses it: a no-guess board never gets there', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A 50/50 the total cannot break: one mine, two cells, nothing else hidden.
    expect(findHint(board(['*o.']))).toEqual({ kind: 'none', complete: true });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('offers nothing before the first dig or after the game ended', () => {
    expect(findHint(createBoard(CHALLENGE))).toEqual({ kind: 'none', complete: true });
    const lost = board(['o*']);
    lost.status = 'lost';
    expect(findHint(lost)).toEqual({ kind: 'none', complete: true });
  });

  it('is deterministic and read-only: the same state gives the same hint, the board untouched', () => {
    const b = board(['.o**', 'o*..', '..o.']);
    const before = JSON.stringify(b);
    const first = findHint(b);
    expect(findHint(b)).toEqual(first);
    expect(findHint(board(['.o**', 'o*..', '..o.']))).toEqual(first);
    expect(JSON.stringify(b)).toBe(before);
  });

  it('finds a next move on a real generated board, from revealed numbers', () => {
    const b = createBoard(CHALLENGE, '8601e326fcef5ef936a1c69d6ab6ac41', 2);
    revealCell(b, 9, 16);
    const hint = findHint(b);
    expect(hint.kind).toBe('numbers');
    if (hint.kind !== 'numbers') return;
    for (const i of hint.cells) {
      expect(b.cells[i].state).toBe('revealed');
      expect(b.cells[i].adjacent).toBeGreaterThan(0);
    }
  });
});
