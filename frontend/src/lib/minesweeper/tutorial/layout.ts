import { createBoard, type Cell, type MinesweeperBoard } from '../game';

/**
 * A TUTORIAL BOARD FROM A PICTURE. A lesson's mini-grid is a handful of rows of characters, so the
 * position it teaches can be read, reviewed and verified as text:
 *
 * - `#` a hidden mine, `.` a hidden safe cell, `F` a flag on a mine (a premise of the lesson);
 * - `0`-`8` a revealed number, which MUST equal the mines around it - a layout whose digit lies is an
 *   authoring error and throws, so a wrong picture can never reach a player;
 * - FOG (owner, 2026-11-27: *"du brouillard, cases en pointille pour signifier que la grille continue sans que
 *   les gens puissent savoir son contenu"*): `~` a hidden safe cell, `X` a hidden mine, that the picture only
 *   suggests - drawn dotted, never playable, and unknown to the player even where a number touches it;
 * - `?` an OPEN cell whose number is not shown (owner, same day: *"des cases avec des nombres '?' comme ca
 *   aucune autre logique n'est possible"*): known to be safe, it tells nothing about its neighbours.
 *
 * Fog and `?` are how a picture keeps only its pattern: every number that is not the pattern's is a `?`, and
 * where the board would continue, it continues into fog rather than ending on a wall.
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

const MINE = new Set(['#', 'X', 'F']);
const HIDDEN = new Set(['#', '.', '~', 'X']);

/**
 * What the picture shows of each cell beyond the engine's own state, read from the layout (index = y * width +
 * x): `unknown` an open cell whose number is hidden (`?`); `fog` a cell the picture only suggests - drawn
 * `~`/`X`, or, in an OPEN picture, a hidden cell that no shown number touches. Neither is ever playable.
 */
export function pictureOf(
  rows: readonly string[],
  open: boolean
): { fog: boolean[]; unknown: boolean[] } {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const unknown: boolean[] = [];
  const fog: boolean[] = [];
  const shown = (x: number, y: number) => rows[y][x] >= '0' && rows[y][x] <= '8';
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = rows[y][x];
      unknown.push(ch === '?');
      const touched = neighbours(x, y, width, height).some(([nx, ny]) => shown(nx, ny));
      fog.push(ch === '~' || ch === 'X' || (open && HIDDEN.has(ch) && !touched));
    }
  }
  return { fog, unknown };
}

/** Builds the engine board a layout pictures; throws on a ragged picture or a digit that lies. */
export function boardFromLayout(rows: readonly string[]): MinesweeperBoard {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  if (height === 0 || width === 0) throw new Error('tutorial layout is empty');
  if (rows.some((r) => r.length !== width))
    throw new Error('tutorial layout rows differ in length');

  const isMine = (x: number, y: number) => MINE.has(rows[y][x]);
  let mineCount = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (isMine(x, y)) mineCount++;

  const board = createBoard({ width, height, mineCount: Math.max(1, mineCount) });
  board.minesPlaced = true;
  board.mineCount = mineCount;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = rows[y][x];
      const cell: Cell = board.cells[y * width + x];
      cell.mine = MINE.has(ch);
      cell.adjacent = neighbours(x, y, width, height).filter(([nx, ny]) => isMine(nx, ny)).length;
      if (ch >= '0' && ch <= '8') {
        if (Number(ch) !== cell.adjacent)
          throw new Error(
            `tutorial layout: (${x},${y}) says ${ch} but ${cell.adjacent} mines surround it`
          );
        cell.state = 'revealed';
        board.revealedCount++;
      } else if (ch === '?') {
        // Open, and safe; its number exists on the board but the picture does not show it.
        cell.state = 'revealed';
        board.revealedCount++;
      } else if (ch === 'F') {
        cell.state = 'flagged';
        board.flagCount++;
      } else if (!HIDDEN.has(ch)) {
        throw new Error(`tutorial layout: unknown character '${ch}' at (${x},${y})`);
      }
    }
  }
  return board;
}
