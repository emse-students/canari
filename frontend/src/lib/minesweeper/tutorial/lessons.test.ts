import { describe, expect, it } from 'vitest';
import type { MinesweeperBoard } from '../game';
import { revealCell, toggleFlag } from '../game';
import { boardFromLayout, pictureOf } from './layout';
import { LESSONS, lessonDone, markCells, type Coord, type Lesson } from './lessons';
import { PATTERNS } from './patterns';

/**
 * EVERY LESSON IS PROVED, NOT READ. A tutorial that teaches a pattern wrong is worse than none, so each
 * picture is checked against ALL the arrangements of mines its shown numbers allow:
 *
 * - what a lesson asks to open is safe in every one, what it asks to flag is a mine in every one, and
 *   the goal IS everything the numbers force - nothing more is asked, nothing forced is left out;
 * - **with the mines counter**, which a player always reads: a lesson that does not teach the counter
 *   must not NEED it (same answer with and without), and the one that teaches it must need it;
 * - every highlight says something true: a red mark is a mine in every arrangement, a green one is safe
 *   in every arrangement, a yellow one holds exactly the mines its badge says;
 * - **a picture holds its pattern and nothing else** (owner, 2026-11-27: *"il faut que ces grilles ne soient
 *   resolvables QUE en comprenant le pattern"*): every number shown is read by the explanation (the others
 *   are `?`), every number read is NEEDED (without it the goal is no longer forced), and in an open picture
 *   no read number sits on the border and a ring of fog around the picture changes nothing it forces - a wall
 *   is information, and a pattern drawn against one can be solved by a smaller one;
 * - **a corner pattern cannot be bypassed**: the corner and the ends of its arms are decided WITH the corner
 *   number and NOT without it.
 *
 * A layout cannot be edited into a position that needs a guess, a shortcut, or a highlight into a claim the
 * numbers do not make, without this file failing.
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

/** A lesson's picture as the proof reads it: the engine board, and what the picture hides. */
interface Picture {
  board: MinesweeperBoard;
  open: boolean;
  /** Hidden cells the picture only suggests: never playable, never part of a goal. */
  fog: boolean[];
  /** Open cells whose number is not shown: safe, and saying nothing. */
  unknown: boolean[];
}

function pictureFor(rows: readonly string[], open: boolean): Picture {
  return { board: boardFromLayout(rows), open, ...pictureOf(rows, open) };
}

/** A number the picture shows (an open cell that is not a `?`). */
const shown = (p: Picture, i: number) => p.board.cells[i].state === 'revealed' && !p.unknown[i];

/** A hidden cell the player may play. */
const playable = (p: Picture, i: number) => p.board.cells[i].state === 'hidden' && !p.fog[i];

interface Arrangements {
  sols: Array<Set<number>>;
  /** The cells the enumeration decides about; any other hidden cell is unknown to it. */
  free: Set<number>;
}

/**
 * Every set of mines consistent with the shown numbers; flags are premises, hidden cells are free. `withCount`
 * also requires the total the mines counter announces. An OPEN picture leaves out the hidden cells no
 * (counted) number touches: they are unknown, never a mine of any arrangement here and never forced. `ignore`
 * leaves numbers out, as if they were `?`. A depth-first search that prunes on every number, so a picture of
 * thirty cells costs what its numbers allow, not 2^30.
 */
function arrangements(
  p: Picture,
  withCount: boolean,
  ignore: readonly number[] = []
): Arrangements {
  const { board } = p;
  const ignored = new Set(ignore);
  const speaks = (i: number) => shown(p, i) && !ignored.has(i);
  const free: number[] = [];
  const fixed = new Set<number>();
  board.cells.forEach((cell, i) => {
    if (cell.state === 'flagged') fixed.add(i);
    else if (cell.state === 'hidden' && (!p.open || neighbours(board, i).some(speaks)))
      free.push(i);
  });
  expect(free.length).toBeLessThanOrEqual(40);
  const slot = new Map(free.map((cell, k) => [cell, k]));
  // One constraint per shown number: the mines it still needs, and the free cells it can take them from.
  const need: number[] = [];
  const cells: number[][] = [];
  board.cells.forEach((cell, i) => {
    if (!speaks(i)) return;
    const around = neighbours(board, i);
    need.push(cell.adjacent - around.filter((n) => fixed.has(n)).length);
    cells.push(around.flatMap((n) => (slot.has(n) ? [slot.get(n)!] : [])));
  });
  const left = cells.map((c) => c.length);
  const touching: number[][] = free.map(() => []);
  cells.forEach((c, k) => c.forEach((v) => touching[v].push(k)));
  const sols: Array<Set<number>> = [];
  const chosen: boolean[] = [];
  const search = (k: number, mines: number) => {
    if (k === free.length) {
      if (need.every((n) => n === 0) && (!withCount || mines + fixed.size === board.mineCount))
        sols.push(new Set([...fixed, ...free.filter((_, v) => chosen[v])]));
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
  return { sols, free: new Set(free) };
}

const numeric = (a: number, b: number) => a - b;

/** The playable cells the numbers force: safe in every arrangement, and mines in every arrangement. */
function forced(p: Picture, { sols, free }: Arrangements) {
  const cells = [...free].filter((i) => playable(p, i));
  return {
    safe: cells.filter((i) => sols.every((s) => !s.has(i))).sort(numeric),
    mine: cells.filter((i) => sols.every((s) => s.has(i))).sort(numeric),
  };
}

/** The same picture inside a ring of fog: what it forces must not depend on where the picture ends. */
function inFog(rows: readonly string[]): string[] {
  const ring = '~'.repeat(rows[0].length + 2);
  return [ring, ...rows.map((r) => `~${r}~`), ring];
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
  // An open picture is a window: its counter reads "?", so the proof leaves the total out.
  const open = lesson.open === true;
  const p = pictureFor(lesson.rows, open);
  const { board } = p;
  const withCount = arrangements(p, !open);
  const withoutCount = arrangements(p, false);
  const mineIn = (c: Coord) => withCount.sols.map((s) => s.has(at(board, c)));
  const goalSafe = lesson.goal.reveal.map((c) => at(board, c)).sort(numeric);
  const goalMine = lesson.goal.flag.map((c) => at(board, c)).sort(numeric);
  const goal = [...goalSafe, ...goalMine];
  const read = [...new Set(lesson.hints.flatMap((step) => step.numbers.map((c) => at(board, c))))];

  it('is consistent: the picture is one of the arrangements its numbers and counter allow', () => {
    // A cell the proof does not decide about is unknown to it, so the picture's mines there are not part of it.
    const truth = new Set(
      board.cells.flatMap((cell, i) =>
        cell.mine && (cell.state === 'flagged' || withCount.free.has(i)) ? [i] : []
      )
    );
    expect(
      withCount.sols.some((s) => s.size === truth.size && [...truth].every((i) => s.has(i)))
    ).toBe(true);
  });

  it('asks to open only cells that are safe in EVERY arrangement', () => {
    for (const c of lesson.goal.reveal) expect(mineIn(c).every((isMine) => !isMine)).toBe(true);
  });

  it('asks to flag only cells that are mines in EVERY arrangement', () => {
    for (const c of lesson.goal.flag) expect(mineIn(c).every(Boolean)).toBe(true);
  });

  it('asks exactly what the numbers force: nothing more, and nothing forced is left out', () => {
    const f = forced(p, withCount);
    expect(f.safe).toEqual(goalSafe);
    expect(f.mine).toEqual(goalMine);
    expect(goal.length).toBeGreaterThan(0);
    for (const i of goal) expect(playable(p, i), `goal cell ${i}`).toBe(true);
  });

  it('shows its pattern and nothing else: every number that speaks about a hidden cell is read by a step', () => {
    for (const [i, cell] of board.cells.entries()) {
      if (!shown(p, i) || !neighbours(board, i).some((n) => board.cells[n].state !== 'revealed'))
        continue;
      expect(read.includes(i), `number ${cell.adjacent} at ${i} is not read: draw it as ?`).toBe(
        true
      );
    }
  });

  if (!COUNTER_LESSONS.has(id)) {
    it('needs every number it reads: without any one of them, part of the goal is no longer forced', () => {
      // Without the counter, which such a lesson does not need (see below): the numbers alone must not suffice.
      for (const n of read) {
        const f = forced(p, arrangements(p, false, [n]));
        const still = [...f.safe, ...f.mine];
        expect(
          goal.every((i) => still.includes(i)),
          `the number at ${n} is not needed`
        ).toBe(false);
      }
    });
  }

  it('never opens the fog: a safe cell to open with no mine around it has no fog beside it', () => {
    for (const i of goalSafe) {
      if (board.cells[i].adjacent > 0) continue;
      expect(
        neighbours(board, i).some((n) => p.fog[n]),
        `cell ${i} would flood the fog`
      ).toBe(false);
    }
  });

  if (open) {
    it('keeps its pattern off the border: a number it reads is never on the edge of the picture', () => {
      for (const i of read) {
        const x = i % board.width;
        const y = Math.floor(i / board.width);
        expect(
          x > 0 && y > 0 && x < board.width - 1 && y < board.height - 1,
          `number at ${i}`
        ).toBe(true);
      }
    });

    it('does not lean on the edge of the board: a ring of fog around the picture changes nothing', () => {
      const q = pictureFor(inFog(lesson.rows), true);
      const f = forced(q, arrangements(q, false));
      const shift = (i: number) =>
        (Math.floor(i / board.width) + 1) * (board.width + 2) + (i % board.width) + 1;
      expect(f.safe).toEqual(goalSafe.map(shift).sort(numeric));
      expect(f.mine).toEqual(goalMine.map(shift).sort(numeric));
    });
  }

  if (lesson.corner) {
    const corner = lesson.corner;
    it('is OPEN: no number settles its own neighbours, so no board edge bypasses the pattern', () => {
      for (const [i, cell] of board.cells.entries()) {
        if (!shown(p, i)) continue;
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

    it('needs the corner number: the corner AND the ends of the arms are forced WITH it, and unknown WITHOUT it', () => {
      const status = (r: Arrangements, i: number) =>
        !r.free.has(i)
          ? '?'
          : r.sols.every((s) => s.has(i))
            ? 'mine'
            : r.sols.every((s) => !s.has(i))
              ? 'safe'
              : '?';
      const without = arrangements(p, !open, [at(board, corner.number)]);
      for (const c of [corner.cell, ...corner.also]) {
        expect(status(withCount, at(board, c)), `with the number, ${c}`).not.toBe('?');
        expect(status(without, at(board, c)), `without the number, ${c}`).toBe('?');
      }
    });
  }

  if (COUNTER_LESSONS.has(id)) {
    it('NEEDS the counter: the numbers alone force strictly less', () => {
      const f = forced(p, withoutCount);
      // Whatever they force is part of the goal, and something of the goal is out of their reach.
      expect(f.safe.every((i) => goalSafe.includes(i))).toBe(true);
      expect(f.mine.every((i) => goalMine.includes(i))).toBe(true);
      expect(f.safe.length + f.mine.length).toBeLessThan(goal.length);
    });
  } else {
    it('does not need the counter: it forces exactly the same without it', () => {
      const f = forced(p, withoutCount);
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
  for (const lesson of ALL) {
    describe(`lesson ${lesson.id}`, () => {
      const p = pictureFor(lesson.rows, lesson.open === true);
      const { board } = p;
      const sols = lesson.guide ? [] : arrangements(p, !p.open).sols;

      lesson.hints.forEach((step, k) => {
        it(`step ${k + 1}: reads real numbers, outlines unopened cells in the grid, and every colour is proved`, () => {
          for (const c of step.numbers) {
            const cell = board.cells[at(board, c)];
            expect(shown(p, at(board, c)), `reads ${c}, which is not a shown number`).toBe(true);
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
            // Fog is never outlined: the picture says nothing about it.
            for (const c of cells) expect(p.fog[at(board, c)], `mark on fog ${c}`).toBe(false);
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
