import { createBoard, type Cell, type MinesweeperBoard } from '../game';

/**
 * A TUTORIAL BOARD FROM A PICTURE. A lesson's mini-grid is a handful of rows of characters, so the
 * position it teaches can be read, reviewed and verified as text:
 *
 * - `#` a hidden mine, `.` a hidden safe cell, `F` a flag on a mine (a premise of the lesson);
 * - `0`-`8` a revealed number, which MUST equal the mines around it - a layout whose digit lies is an
 *   authoring error and throws, so a wrong picture can never reach a player.
 *
 * The board is the engine's own, with its mines already placed (`minesPlaced`), so the lesson plays on
 * `revealCell`, `toggleFlag` and `chordCell` exactly as the real game does: what the tutorial teaches is
 * what the game does, by construction.
 */

/** The eight neighbours of a cell, in bounds. */
function neighbours(x: number, y: number, width: number, height: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if ((dx !== 0 || dy !== 0) && x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height)
        out.push([x + dx, y + dy]);
    }
  }
  return out;
}

/** Builds the engine board a layout pictures; throws on a ragged picture or a digit that lies. */
export function boardFromLayout(rows: readonly string[]): MinesweeperBoard {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  if (height === 0 || width === 0) throw new Error('tutorial layout is empty');
  if (rows.some((r) => r.length !== width))
    throw new Error('tutorial layout rows differ in length');

  const isMine = (x: number, y: number) => rows[y][x] === '#' || rows[y][x] === 'F';
  let mineCount = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (isMine(x, y)) mineCount++;

  const board = createBoard({ width, height, mineCount: Math.max(1, mineCount) });
  board.minesPlaced = true;
  board.mineCount = mineCount;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = rows[y][x];
      const cell: Cell = board.cells[y * width + x];
      cell.mine = ch === '#' || ch === 'F';
      cell.adjacent = neighbours(x, y, width, height).filter(([nx, ny]) => isMine(nx, ny)).length;
      if (ch >= '0' && ch <= '8') {
        if (Number(ch) !== cell.adjacent)
          throw new Error(
            `tutorial layout: (${x},${y}) says ${ch} but ${cell.adjacent} mines surround it`
          );
        cell.state = 'revealed';
        board.revealedCount++;
      } else if (ch === 'F') {
        cell.state = 'flagged';
        board.flagCount++;
      } else if (ch !== '#' && ch !== '.') {
        throw new Error(`tutorial layout: unknown character '${ch}' at (${x},${y})`);
      }
    }
  }
  return board;
}
