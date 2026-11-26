import { describe, expect, it } from 'vitest';
import type { MinesweeperBoard } from '../game';
import { revealCell, toggleFlag } from '../game';
import { boardFromLayout } from './layout';
import { LESSONS, lessonDone, markCells, type Coord, type Lesson } from './lessons';

/**
 * EVERY LESSON IS PROVED, NOT READ. A tutorial that teaches a pattern wrong is worse than none, so each
 * picture is checked against ALL the arrangements of mines its visible numbers allow:
 *
 * - what a lesson asks to open is safe in every one, what it asks to flag is a mine in every one, and
 *   nothing the numbers force is left unasked;
 * - **with the mines counter**, which a player always reads: a lesson that does not teach the counter
 *   must not NEED it (same answer with and without), and the one that teaches it must need it;
 * - every highlight says something true: a red mark is a mine in every arrangement, a green one is safe
 *   in every arrangement, a yellow one holds exactly the mines its badge says.
 *
 * A layout cannot be edited into a position that needs a guess, or a highlight into a claim the numbers
 * do not make, without this file failing.
 */

const at = (board: MinesweeperBoard, [x, y]: Coord) => y * board.width + x;

function neighbours(board: MinesweeperBoard, i: number): number[] {
  const x = i % board.width;
  const y = Math.floor(i / board.width);
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if ((dx || dy) && nx >= 0 && nx < board.width && ny >= 0 && ny < board.height)
        out.push(ny * board.width + nx);
    }
  }
  return out;
}

/**
 * Every set of mines consistent with the revealed numbers; flags are premises, hidden cells are free.
 * `withCount` also requires the total the mines counter announces.
 */
function arrangements(board: MinesweeperBoard, withCount: boolean): Array<Set<number>> {
  const free: number[] = [];
  const fixed = new Set<number>();
  board.cells.forEach((cell, i) => {
    if (cell.state === 'hidden') free.push(i);
    else if (cell.state === 'flagged') fixed.add(i);
  });
  expect(free.length).toBeLessThanOrEqual(16);
  const out: Array<Set<number>> = [];
  for (let bits = 0; bits < 1 << free.length; bits++) {
    const mines = new Set(fixed);
    free.forEach((cell, k) => {
      if (bits & (1 << k)) mines.add(cell);
    });
    if (withCount && mines.size !== board.mineCount) continue;
    const consistent = board.cells.every(
      (cell, i) =>
        cell.state !== 'revealed' ||
        neighbours(board, i).filter((n) => mines.has(n)).length === cell.adjacent
    );
    if (consistent) out.push(mines);
  }
  return out;
}

const numeric = (a: number, b: number) => a - b;

/** The hidden cells the numbers force: safe in every arrangement, and mines in every arrangement. */
function forced(board: MinesweeperBoard, sols: Array<Set<number>>) {
  const hidden = board.cells.flatMap((cell, i) => (cell.state === 'hidden' ? [i] : []));
  return {
    safe: hidden.filter((i) => sols.every((s) => !s.has(i))).sort(numeric),
    mine: hidden.filter((i) => sols.every((s) => s.has(i))).sort(numeric),
  };
}

const deductive = LESSONS.filter((l) => l.guide === undefined);
const COUNTER_LESSON = 'counter';

describe('the lessons are well formed', () => {
  it('has distinct ids, each with a title, a body and at least one hint', () => {
    expect(new Set(LESSONS.map((l) => l.id)).size).toBe(LESSONS.length);
    for (const lesson of LESSONS) {
      expect(lesson.title().length).toBeGreaterThan(0);
      expect(lesson.body().length).toBeGreaterThan(0);
      expect(lesson.hints.length).toBeGreaterThan(0);
      for (const step of lesson.hints) expect(step.text().length).toBeGreaterThan(0);
    }
  });

  it('teaches what the owner named: the counter, the automatic flags, the chord, the patterns and the corners', () => {
    expect(LESSONS.map((l) => l.id)).toEqual(
      expect.arrayContaining([
        'counter',
        'autoflag',
        'chord',
        'one_two_one',
        'one_two_two_one',
        'angle_one_three_one',
        'angle_two_two_two',
      ])
    );
  });
});

describe.each(deductive.map((l) => [l.id, l] as [string, Lesson]))('lesson %s', (id, lesson) => {
  const board = boardFromLayout(lesson.rows);
  const withCount = arrangements(board, true);
  const withoutCount = arrangements(board, false);
  const mineIn = (c: Coord) => withCount.map((s) => s.has(at(board, c)));
  const goalSafe = lesson.goal.reveal.map((c) => at(board, c)).sort(numeric);
  const goalMine = lesson.goal.flag.map((c) => at(board, c)).sort(numeric);

  it('is consistent: the picture is one of the arrangements its numbers and counter allow', () => {
    const truth = new Set(board.cells.flatMap((cell, i) => (cell.mine ? [i] : [])));
    expect(withCount.some((s) => s.size === truth.size && [...truth].every((i) => s.has(i)))).toBe(
      true
    );
  });

  it('asks to open only cells that are safe in EVERY arrangement', () => {
    for (const c of lesson.goal.reveal) expect(mineIn(c).every((isMine) => !isMine)).toBe(true);
  });

  it('asks to flag only cells that are mines in EVERY arrangement', () => {
    for (const c of lesson.goal.flag) expect(mineIn(c).every(Boolean)).toBe(true);
  });

  it('leaves no deduction unasked: the goal IS what the numbers and the counter force', () => {
    const f = forced(board, withCount);
    expect(f.safe).toEqual(goalSafe);
    expect(f.mine).toEqual(goalMine);
  });

  if (id === COUNTER_LESSON) {
    it('NEEDS the counter: the numbers alone force strictly less', () => {
      const f = forced(board, withoutCount);
      expect(f.safe.length).toBeLessThan(goalSafe.length);
      expect(f.mine).toEqual(goalMine);
    });
  } else {
    it('does not need the counter: it forces exactly the same without it', () => {
      const f = forced(board, withoutCount);
      expect(f.safe).toEqual(goalSafe);
      expect(f.mine).toEqual(goalMine);
    });
  }
});

describe('the guided lesson', () => {
  const lesson = LESSONS.find((l) => l.guide !== undefined)!;

  it('points at a cell that is safe, and asks to open exactly that', () => {
    const board = boardFromLayout(lesson.rows);
    const target = lesson.guide!.flatMap(markCells);
    for (const c of target) expect(board.cells[at(board, c)].mine).toBe(false);
    expect(lesson.goal.reveal).toEqual(target);
    expect(lesson.goal.flag).toEqual([]);
  });
});

describe('the highlights say something true', () => {
  for (const lesson of LESSONS) {
    describe(`lesson ${lesson.id}`, () => {
      const board = boardFromLayout(lesson.rows);
      const sols = lesson.guide ? [] : arrangements(board, true);

      lesson.hints.forEach((step, k) => {
        it(`step ${k + 1}: reads real numbers, outlines unopened cells in the grid, and every colour is proved`, () => {
          for (const c of step.numbers) {
            const cell = board.cells[at(board, c)];
            expect(cell.state).toBe('revealed');
            expect(cell.adjacent).toBeGreaterThan(0);
          }
          for (const mark of step.marks) {
            expect(mark.rects.length).toBeGreaterThan(0);
            for (const [x, y, w, h] of mark.rects) {
              expect(w).toBeGreaterThan(0);
              expect(h).toBeGreaterThan(0);
              expect(x).toBeGreaterThanOrEqual(0);
              expect(y).toBeGreaterThanOrEqual(0);
              expect(x + w).toBeLessThanOrEqual(board.width);
              expect(y + h).toBeLessThanOrEqual(board.height);
            }
            const cells = markCells(mark);
            // A rectangle is outlined as ONE shape: it must not hide a cell that is open.
            for (const c of cells) expect(board.cells[at(board, c)].state).not.toBe('revealed');
            // The mark's cells are never listed twice (two rectangles of a mark do not overlap).
            expect(new Set(cells.map((c) => at(board, c))).size).toBe(cells.length);
            if (lesson.guide) continue; // a gesture lesson has no deduction to prove
            const idx = cells.map((c) => at(board, c));
            if (mark.kind === 'mine')
              for (const s of sols) for (const i of idx) expect(s.has(i)).toBe(true);
            if (mark.kind === 'safe')
              for (const s of sols) for (const i of idx) expect(s.has(i)).toBe(false);
            if (mark.kind === 'group') {
              // A group is outlined because a lit number speaks about it.
              for (const i of idx)
                expect(step.numbers.some((n) => neighbours(board, at(board, n)).includes(i))).toBe(
                  true
                );
              if (mark.count !== undefined)
                for (const s of sols) expect(idx.filter((i) => s.has(i)).length).toBe(mark.count);
            }
          }
        });
      });
    });
  }
});

describe('lessonDone', () => {
  it('passes when every goal cell is done and nothing safe is flagged', () => {
    const lesson = LESSONS.find((l) => l.id === 'flag')!;
    const board = boardFromLayout(lesson.rows);
    expect(lessonDone(board, lesson.goal)).toBe(false);
    toggleFlag(board, 2, 2);
    expect(lessonDone(board, lesson.goal)).toBe(true);
  });

  it('does not pass with a wrong flag beside the right one: a lucky guess is not a deduction', () => {
    const lesson = LESSONS.find((l) => l.id === 'one_two_one')!;
    const board = boardFromLayout(lesson.rows);
    toggleFlag(board, 0, 1);
    toggleFlag(board, 2, 1);
    toggleFlag(board, 1, 1);
    revealCell(board, 1, 1); // a flagged cell is not opened
    expect(lessonDone(board, lesson.goal)).toBe(false);
  });

  it('fails once a mine was opened', () => {
    const lesson = LESSONS.find((l) => l.id === 'flag')!;
    const board = boardFromLayout(lesson.rows);
    revealCell(board, 2, 2);
    expect(lessonDone(board, lesson.goal)).toBe(false);
  });

  it('is done after a chord opens what the flags make safe', () => {
    const lesson = LESSONS.find((l) => l.id === 'chord')!;
    const board = boardFromLayout(lesson.rows);
    revealCell(board, 1, 1);
    expect(lessonDone(board, lesson.goal)).toBe(true);
  });

  it('is done after one tap on the number: the game flags what the count makes certain', () => {
    const lesson = LESSONS.find((l) => l.id === 'autoflag')!;
    const board = boardFromLayout(lesson.rows);
    revealCell(board, 1, 1);
    expect(board.flagCount).toBe(2);
    expect(lessonDone(board, lesson.goal)).toBe(true);
  });

  it('needs the flag AND the rest opened when the counter reads zero', () => {
    const lesson = LESSONS.find((l) => l.id === 'counter')!;
    const board = boardFromLayout(lesson.rows);
    toggleFlag(board, 1, 1);
    expect(board.mineCount - board.flagCount).toBe(0);
    expect(lessonDone(board, lesson.goal)).toBe(false);
    revealCell(board, 3, 1); // a zero: the two right columns open by themselves
    revealCell(board, 1, 0);
    revealCell(board, 1, 2);
    expect(lessonDone(board, lesson.goal)).toBe(true);
  });
});
