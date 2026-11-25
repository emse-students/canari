import { describe, expect, it } from 'vitest';
import type { MinesweeperBoard } from '../game';
import { revealCell, toggleFlag } from '../game';
import { boardFromLayout } from './layout';
import { LESSONS, lessonDone, type Coord, type Lesson } from './lessons';

/**
 * EVERY LESSON IS PROVED, NOT READ. A tutorial that teaches a pattern wrong is worse than none, so each
 * picture is checked against ALL the arrangements of mines its visible numbers allow: what a lesson asks
 * the player to open must be safe in every one of them, what it asks them to flag must be a mine in
 * every one, and no deduction the picture supports may be left unasked. A layout cannot be edited into
 * a position that needs a guess without this file failing.
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

/** Every set of mines consistent with the revealed numbers; flags are premises, hidden cells are free. */
function arrangements(board: MinesweeperBoard): Array<Set<number>> {
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
    const consistent = board.cells.every(
      (cell, i) =>
        cell.state !== 'revealed' ||
        neighbours(board, i).filter((n) => mines.has(n)).length === cell.adjacent
    );
    if (consistent) out.push(mines);
  }
  return out;
}

const deductive = LESSONS.filter((l) => l.guide === undefined);

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

  it('teaches the patterns the owner named: chording, 1-2-1 and 1-2-2-1', () => {
    expect(LESSONS.map((l) => l.id)).toEqual(
      expect.arrayContaining(['chord', 'one_two_one', 'one_two_two_one'])
    );
  });
});

describe.each(deductive.map((l) => [l.id, l] as [string, Lesson]))('lesson %s', (_id, lesson) => {
  const board = boardFromLayout(lesson.rows);
  const solutions = arrangements(board);
  const mineIn = (c: Coord) => solutions.map((s) => s.has(at(board, c)));

  it('is consistent: the picture is one of the arrangements its numbers allow', () => {
    const truth = new Set(board.cells.flatMap((cell, i) => (cell.mine ? [i] : [])));
    expect(solutions.some((s) => s.size === truth.size && [...truth].every((i) => s.has(i)))).toBe(
      true
    );
  });

  it('asks to open only cells that are safe in EVERY arrangement', () => {
    for (const c of lesson.goal.reveal) expect(mineIn(c).every((isMine) => !isMine)).toBe(true);
  });

  it('asks to flag only cells that are mines in EVERY arrangement', () => {
    for (const c of lesson.goal.flag) expect(mineIn(c).every(Boolean)).toBe(true);
  });

  it('leaves no deduction unasked: the goal IS what the numbers force', () => {
    const hidden = board.cells.flatMap((cell, i) => (cell.state === 'hidden' ? [i] : []));
    const forcedSafe = hidden.filter((i) => solutions.every((s) => !s.has(i)));
    const forcedMine = hidden.filter((i) => solutions.every((s) => s.has(i)));
    const numeric = (a: number, b: number) => a - b;
    expect(forcedSafe.sort(numeric)).toEqual(
      lesson.goal.reveal.map((c) => at(board, c)).sort(numeric)
    );
    expect(forcedMine.sort(numeric)).toEqual(
      lesson.goal.flag.map((c) => at(board, c)).sort(numeric)
    );
  });
});

describe('the guided lesson', () => {
  const lesson = LESSONS.find((l) => l.guide !== undefined)!;

  it('points at a cell that is safe, and asks to open exactly that', () => {
    const board = boardFromLayout(lesson.rows);
    for (const c of lesson.guide!) expect(board.cells[at(board, c)].mine).toBe(false);
    expect(lesson.goal.reveal).toEqual(lesson.guide);
    expect(lesson.goal.flag).toEqual([]);
  });
});

describe('the hints', () => {
  for (const lesson of LESSONS) {
    it(`${lesson.id}: read real numbers and speak about cells they touch`, () => {
      const board = boardFromLayout(lesson.rows);
      for (const step of lesson.hints) {
        for (const c of step.numbers) {
          const cell = board.cells[at(board, c)];
          expect(cell.state).toBe('revealed');
          expect(cell.adjacent).toBeGreaterThan(0);
        }
        for (const c of step.group) {
          expect(board.cells[at(board, c)].state).not.toBe('revealed');
          // A cell is in the group because a lit number touches it (a gesture hint has no number).
          if (step.numbers.length > 0)
            expect(
              step.numbers.some((n) => neighbours(board, at(board, n)).includes(at(board, c)))
            ).toBe(true);
        }
      }
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
});
