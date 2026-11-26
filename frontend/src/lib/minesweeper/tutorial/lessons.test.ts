import { describe, expect, it } from 'vitest';
import type { MinesweeperBoard } from '../game';
import { revealCell, toggleFlag } from '../game';
import { boardFromLayout } from './layout';
import { LESSONS, lessonDone, markCells, type Coord, type Lesson } from './lessons';
import { PATTERNS } from './patterns';

/**
 * EVERY LESSON IS PROVED, NOT READ. A tutorial that teaches a pattern wrong is worse than none, so each
 * picture is checked against ALL the arrangements of mines its visible numbers allow:
 *
 * - what a lesson asks to open is safe in every one, what it asks to flag is a mine in every one, and
 *   nothing the numbers force is left unasked;
 * - **with the mines counter**, which a player always reads: a lesson that does not teach the counter
 *   must not NEED it (same answer with and without), and the one that teaches it must need it;
 * - every highlight says something true: a red mark is a mine in every arrangement, a green one is safe
 *   in every arrangement, a yellow one holds exactly the mines its badge says;
 * - **a corner pattern cannot be bypassed** (owner, 2026-11-26: a board edge made the ends of the arms
 *   trivial and let the lesson skip the corner reasoning): no number of the picture settles its own
 *   neighbours, and the corner cell is decided WITH the corner number and NOT without it.
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

/** A hidden cell no revealed number touches: in an open window the numbers say nothing about it. */
function isFar(board: MinesweeperBoard, i: number): boolean {
  return !neighbours(board, i).some((n) => board.cells[n].state === 'revealed');
}

/**
 * Every set of mines consistent with the revealed numbers; flags are premises, hidden cells are free.
 * `withCount` also requires the total the mines counter announces. An OPEN window leaves out the cells no
 * number touches (they are drawn dotted and cannot be played): they are unknown, so they are never a mine
 * of any arrangement here and never forced. A depth-first search that prunes on every number, so a window
 * of thirty cells costs what its numbers allow, not 2^30.
 */
function arrangements(
  board: MinesweeperBoard,
  withCount: boolean,
  /** A revealed number to leave out of the constraints, as if the player had not opened it. */
  ignore?: number,
  open = false
): Array<Set<number>> {
  const free: number[] = [];
  const fixed = new Set<number>();
  board.cells.forEach((cell, i) => {
    if (cell.state === 'hidden' && !(open && isFar(board, i))) free.push(i);
    else if (cell.state === 'flagged') fixed.add(i);
  });
  expect(free.length).toBeLessThanOrEqual(40);
  const slot = new Map(free.map((cell, k) => [cell, k]));
  // One constraint per revealed number: the mines it still needs, and the free cells it can take them from.
  const need: number[] = [];
  const cells: number[][] = [];
  board.cells.forEach((cell, i) => {
    if (cell.state !== 'revealed' || i === ignore) return;
    const around = neighbours(board, i);
    need.push(cell.adjacent - around.filter((n) => fixed.has(n)).length);
    cells.push(around.flatMap((n) => (slot.has(n) ? [slot.get(n)!] : [])));
  });
  const left = cells.map((c) => c.length);
  const touching: number[][] = free.map(() => []);
  cells.forEach((c, k) => c.forEach((v) => touching[v].push(k)));
  const out: Array<Set<number>> = [];
  const chosen: boolean[] = [];
  const search = (k: number, mines: number) => {
    if (k === free.length) {
      if (need.every((n) => n === 0) && (!withCount || mines + fixed.size === board.mineCount))
        out.push(new Set([...fixed, ...free.filter((_, v) => chosen[v])]));
      return;
    }
    for (const mine of [false, true]) {
      chosen[k] = mine;
      for (const c of touching[k]) {
        left[c]--;
        if (mine) need[c]--;
      }
      if (touching[k].every((c) => need[c] >= 0 && need[c] <= left[c]))
        search(k + 1, mines + (mine ? 1 : 0));
      for (const c of touching[k]) {
        left[c]++;
        if (mine) need[c]++;
      }
    }
  };
  search(0, 0);
  return out;
}

const numeric = (a: number, b: number) => a - b;

/** The hidden cells the numbers force: safe in every arrangement, and mines in every arrangement. */
function forced(board: MinesweeperBoard, sols: Array<Set<number>>, open = false) {
  const hidden = board.cells.flatMap((cell, i) =>
    cell.state === 'hidden' && !(open && isFar(board, i)) ? [i] : []
  );
  return {
    safe: hidden.filter((i) => sols.every((s) => !s.has(i))).sort(numeric),
    mine: hidden.filter((i) => sols.every((s) => s.has(i))).sort(numeric),
  };
}

/** Every lesson of the tutorial AND every entry of the pattern catalogue (its annex). */
const ALL: readonly Lesson[] = [...LESSONS, ...PATTERNS];
const deductive = ALL.filter((l) => l.guide === undefined);
/** The lessons that teach the counter, so are allowed (and required) to need it. */
const COUNTER_LESSONS = new Set(['counter', 'mine_counting', 'combinations']);

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

  it("teaches the gestures and the rules, and no pattern: those are the annex's (owner, 2026-11-26)", () => {
    expect(LESSONS.map((l) => l.id)).toEqual(['reveal', 'flag', 'autoflag', 'chord', 'counter']);
    // A pattern is shown in the catalogue and only there: no lesson shares an id with an entry of it.
    for (const lesson of LESSONS) expect(PATTERNS.some((p) => p.id === lesson.id)).toBe(false);
  });
});

describe.each(deductive.map((l) => [l.id, l] as [string, Lesson]))('lesson %s', (id, lesson) => {
  const board = boardFromLayout(lesson.rows);
  // An open grid is a window: its counter reads "?", so the proof leaves the total out.
  const open = lesson.open === true;
  const withCount = arrangements(board, !open, undefined, open);
  const withoutCount = arrangements(board, false, undefined, open);
  const mineIn = (c: Coord) => withCount.map((s) => s.has(at(board, c)));
  const goalSafe = lesson.goal.reveal.map((c) => at(board, c)).sort(numeric);
  const goalMine = lesson.goal.flag.map((c) => at(board, c)).sort(numeric);

  it('is consistent: the picture is one of the arrangements its numbers and counter allow', () => {
    // A far cell of an open window is unknown, so the picture's mines there are not part of the proof.
    const truth = new Set(
      board.cells.flatMap((cell, i) =>
        cell.mine && !(open && cell.state === 'hidden' && isFar(board, i)) ? [i] : []
      )
    );
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
    const f = forced(board, withCount, open);
    if (lesson.partial) {
      // A catalogue window: the goal is what the PATTERN concludes, and it must be forced.
      expect(f.safe).toEqual(expect.arrayContaining(goalSafe));
      expect(f.mine).toEqual(expect.arrayContaining(goalMine));
      expect(goalSafe.length + goalMine.length).toBeGreaterThan(0);
    } else {
      expect(f.safe).toEqual(goalSafe);
      expect(f.mine).toEqual(goalMine);
    }
  });

  if (lesson.corner) {
    const corner = lesson.corner;
    it('is OPEN: no number settles its own neighbours, so no board edge bypasses the pattern', () => {
      for (const [i, cell] of board.cells.entries()) {
        if (cell.state !== 'revealed') continue;
        const hidden = neighbours(board, i).filter((n) => board.cells[n].state !== 'revealed');
        if (hidden.length === 0) continue;
        // A 0 clears its neighbours, and a number equal to its hidden neighbours marks them all: either
        // concludes without any pattern.
        expect(cell.adjacent, `number at ${i} touches ${hidden.length} hidden cells`).not.toBe(0);
        expect(cell.adjacent, `number at ${i} touches ${hidden.length} hidden cells`).not.toBe(
          hidden.length
        );
      }
    });

    it('needs the corner number: its cell is forced WITH it, and unknown WITHOUT it', () => {
      const cellIndex = at(board, corner.cell);
      const status = (sols: Array<Set<number>>) =>
        sols.every((s) => s.has(cellIndex))
          ? 'mine'
          : sols.every((s) => !s.has(cellIndex))
            ? 'safe'
            : '?';
      expect(status(withCount)).not.toBe('?');
      expect(status(arrangements(board, !open, at(board, corner.number), open))).toBe('?');
    });
  }

  if (COUNTER_LESSONS.has(id)) {
    it('NEEDS the counter: the numbers alone force strictly less', () => {
      const f = forced(board, withoutCount, open);
      if (lesson.partial) {
        // Something the pattern concludes is out of the numbers' reach.
        expect(
          goalSafe.some((i) => !f.safe.includes(i)) || goalMine.some((i) => !f.mine.includes(i))
        ).toBe(true);
        return;
      }
      // Whatever they force is part of the goal, and something of the goal is out of their reach.
      expect(f.safe.every((i) => goalSafe.includes(i))).toBe(true);
      expect(f.mine.every((i) => goalMine.includes(i))).toBe(true);
      expect(f.safe.length + f.mine.length).toBeLessThan(goalSafe.length + goalMine.length);
    });
  } else {
    it('does not need the counter: it forces exactly the same without it', () => {
      const f = forced(board, withoutCount, open);
      const g = forced(board, withCount, open);
      expect(f.safe).toEqual(g.safe);
      expect(f.mine).toEqual(g.mine);
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
  for (const lesson of ALL) {
    describe(`lesson ${lesson.id}`, () => {
      const board = boardFromLayout(lesson.rows);
      const sols = lesson.guide ? [] : arrangements(board, !lesson.open, undefined, lesson.open);

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

describe('the pattern catalogue (the tutorial annex)', () => {
  it('lists every pattern of the reference catalogue, in its order and once', () => {
    const ids = PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'basic_mines', // B1
      'basic_flags', // B2
      'one_one',
      'one_one_plus',
      'one_two',
      'one_two_plus',
      'one_two_c',
      'one_two_c_plus',
      'one_two_one',
      'one_two_two_one',
      'reduction_intro', // ours: the reference goes straight to the three reductions
      'reduced_one_one',
      'reduced_one_two',
      'reduced_one_two_one',
      'hole_1',
      'hole_2',
      'hole_3',
      'triangle_1',
      'triangle_2',
      'triangle_3',
      'triangle_4',
      'triangle_5',
      'corner_one_three_one',
      'corner_two_two_two',
      'gt_two_lt',
      't_pattern',
      'chain',
      'mine_counting',
      'combinations',
    ]);
  });

  it('puts every entry under a family, with a title, a body and a text per step', () => {
    for (const p of PATTERNS) {
      expect(p.section, p.id).toBeDefined();
      expect(p.section!().length).toBeGreaterThan(0);
      expect(p.title().length).toBeGreaterThan(0);
      expect(p.body().length).toBeGreaterThan(0);
      expect(p.hints.length).toBeGreaterThan(0);
      for (const step of p.hints) expect(step.text().length).toBeGreaterThan(0);
    }
  });

  it('keeps the families together, so the jump list groups them', () => {
    const sections = PATTERNS.map((p) => p.section!());
    const seen = new Set<string>();
    let previous = '';
    for (const s of sections) {
      if (s !== previous) expect(seen.has(s), `family '${s}' is split`).toBe(false);
      seen.add(s);
      previous = s;
    }
  });
});

describe('a reduced number is the number minus the flags it touches', () => {
  const withReduction = ALL.flatMap((l) =>
    l.hints.flatMap((step, k) => (step.reduced ? [[l, step, k] as const] : []))
  );

  it('is taught by at least the introduction and the three reduction patterns', () => {
    expect(new Set(withReduction.map(([l]) => l.id))).toEqual(
      new Set(['reduction_intro', 'reduced_one_one', 'reduced_one_two', 'reduced_one_two_one'])
    );
  });

  for (const [lesson, step, k] of withReduction) {
    it(`${lesson.id}, step ${k + 1}: every label is the digit minus the flags around it`, () => {
      const board = boardFromLayout(lesson.rows);
      for (const { cell, value } of step.reduced!) {
        const i = at(board, cell);
        expect(board.cells[i].state).toBe('revealed');
        const flags = neighbours(board, i).filter((n) => board.cells[n].state === 'flagged').length;
        expect(flags).toBeGreaterThan(0);
        expect(value).toBe(board.cells[i].adjacent - flags);
        // A reduced number is one the step is reading.
        expect(step.numbers.some(([x, y]) => at(board, [x, y]) === i)).toBe(true);
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
    const lesson = PATTERNS.find((l) => l.id === 'one_two_one')!;
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
