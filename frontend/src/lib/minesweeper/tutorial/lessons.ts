import { m } from '$lib/paraglide/messages';
import type { MinesweeperBoard } from '../game';

/**
 * THE TUTORIAL'S LESSONS: the gestures and the rules, and no pattern (owner, 2026-11-26: *"les patterns
 * specifiques ne devraient pas etre enseignes direct, mais plutot rester dans l'onglet patterns"* - they are
 * the annex's, `patterns.ts`). (owner, 2026-11-25: *"une section tutoriel qui explique le fonctionnement du
 * demineur avec des mini-grilles"*, with a hint button that SHOWS the reasoning). A lesson is a picture
 * ({@link boardFromLayout}), a goal, and the steps of its explanation. The pictures are TEXT, and
 * `lessons.test.ts` proves each one against EVERY arrangement of mines the visible numbers AND the mines
 * counter allow: what a lesson asks to open is safe, what it asks to flag is a mine, nothing the numbers
 * force is left unasked, and every highlight says something true - so a pattern cannot be taught wrong.
 */

/** A cell, as `[x, y]`. */
export type Coord = readonly [number, number];

/** A rectangle of cells: `[x, y, width, height]`. */
export type Rect = readonly [number, number, number, number];

/** What a lesson asks: cells to open (all safe) and cells to flag (all mines). */
export interface LessonGoal {
  reveal: readonly Coord[];
  flag: readonly Coord[];
}

/**
 * What a highlight says (owner, 2026-11-26): RED a mine that is certain, YELLOW a group of cells
 * holding mines (with how many, when it is exact), GREEN a cell that is certain to be safe. A mark is
 * ONE outline around its rectangle, never a ring per cell, so a group of several cells reads as a group.
 */
export type MarkKind = 'mine' | 'group' | 'safe';

export interface HintMark {
  kind: MarkKind;
  /**
   * The rectangle(s) of the mark. Several rectangles are ONE mark when the cells are not a rectangle (the
   * five cells a corner number sees): they share a colour and a badge, and are proved together.
   */
  rects: readonly Rect[];
  /** For a `group`: exactly how many mines it holds, in every arrangement the numbers allow. */
  count?: number;
}

/**
 * One step of the "Indice" button: the NUMBER(S) the reasoning reads (ringed) and what it concludes,
 * as marks. Authored, not computed: a step explains a pattern, and the order a person reads it in is a
 * teaching choice.
 */
interface HintStep {
  numbers: readonly Coord[];
  marks: readonly HintMark[];
  /**
   * REDUCTION (owner, 2026-11-26): numbers drawn with what is left of them once the flags they touch are
   * taken off - `2 -> 1` for a 2 beside one flag. The test holds `value` to the board: the number minus
   * its flagged neighbours, so a label cannot teach a wrong subtraction.
   */
  reduced?: readonly { cell: Coord; value: number }[];
  text: () => string;
}

export interface Lesson {
  id: string;
  /** The group a catalogue entry belongs to (the annex lists patterns by family); absent in the tutorial. */
  section?: () => string;
  title: () => string;
  body: () => string;
  /** The picture, see `layout.ts`. */
  rows: readonly string[];
  goal: LessonGoal;
  /**
   * AN OPEN GRID (owner, 2026-11-26: *"une continuite avec des cases non importantes, un nombre inconnu de
   * mines et des pointilles qui continuent la grille"*): the picture is a window on a larger board. The
   * hidden cells no number touches are drawn dotted and cannot be played, the mines counter reads "?",
   * and the proof leaves the counter out - so a pattern is taught on what the numbers say, never on a
   * total the picture happens to carry.
   */
  open?: boolean;
  /**
   * A CATALOGUE window holds more than the pattern asks (the reference's pictures are crops of larger boards):
   * the goal is what the PATTERN concludes, the test holds it to be forced, and the numbers around the pattern
   * may force more than the goal asks. A tutorial lesson is exact: its goal IS everything forced.
   */
  partial?: boolean;
  /**
   * Marks shown from the start, before any hint: a lesson that teaches a GESTURE (open a cell) shows
   * where. Such a lesson has no deduction to verify, only a safe target.
   */
  guide?: readonly HintMark[];
  /**
   * For a CORNER pattern: the number whose reasoning the lesson teaches, and the cell it decides. The test
   * holds the picture to it (owner, 2026-11-26): no number may settle its own neighbours (a 0, or as many
   * mines as hidden neighbours - a board edge makes that easy), and that cell - AND each of `also`, the ends of the arms - must be forced WITH
   * the number and NOT without it, so the pattern cannot be bypassed and no guess of the corner is enough.
   */
  corner?: { number: Coord; cell: Coord; also: readonly Coord[] };
  hints: readonly HintStep[];
}

/** A mark of certain mines, drawn as one red outline per rectangle. */
export const mine = (...rects: Rect[]): HintMark => ({ kind: 'mine', rects });
/** A mark of certain safe cells, in green. */
export const safe = (...rects: Rect[]): HintMark => ({ kind: 'safe', rects });
/** A group of cells holding `count` mines (exact), or an unspecified number when `count` is undefined. */
export const group = (count: number | undefined, ...rects: Rect[]): HintMark => ({
  kind: 'group',
  rects,
  count,
});

/** Every cell of a mark, in reading order. */
export function markCells(mark: HintMark): Coord[] {
  const cells: Coord[] = [];
  for (const [x, y, w, h] of mark.rects)
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) cells.push([x + dx, y + dy]);
  return cells;
}

export const LESSONS: readonly Lesson[] = [
  {
    id: 'reveal',
    title: () => m.minesweeper_tutorial_lesson_reveal_title(),
    body: () => m.minesweeper_tutorial_lesson_reveal_body(),
    rows: ['.....', '.....', '.#...', '....#'],
    goal: { reveal: [[0, 0]], flag: [] },
    guide: [safe([0, 0, 1, 1])],
    hints: [
      {
        numbers: [],
        marks: [safe([0, 0, 1, 1])],
        text: () => m.minesweeper_tutorial_lesson_reveal_hint_1(),
      },
    ],
  },
  {
    id: 'flag',
    title: () => m.minesweeper_tutorial_lesson_flag_title(),
    body: () => m.minesweeper_tutorial_lesson_flag_body(),
    rows: ['000', '011', '01#'],
    goal: { reveal: [], flag: [[2, 2]] },
    hints: [
      {
        numbers: [[1, 1]],
        marks: [group(1, [2, 2, 1, 1])],
        text: () => m.minesweeper_tutorial_lesson_flag_hint_1(),
      },
      {
        numbers: [
          [1, 2],
          [2, 1],
        ],
        marks: [mine([2, 2, 1, 1])],
        text: () => m.minesweeper_tutorial_lesson_flag_hint_2(),
      },
    ],
  },
  {
    id: 'autoflag',
    title: () => m.minesweeper_tutorial_lesson_autoflag_title(),
    body: () => m.minesweeper_tutorial_lesson_autoflag_body(),
    rows: ['011', '02#', '02#'],
    goal: {
      reveal: [],
      flag: [
        [2, 1],
        [2, 2],
      ],
    },
    hints: [
      {
        numbers: [[1, 1]],
        marks: [group(2, [2, 1, 1, 2])],
        text: () => m.minesweeper_tutorial_lesson_autoflag_hint_1(),
      },
      {
        numbers: [[1, 1]],
        marks: [mine([2, 1, 1, 2])],
        text: () => m.minesweeper_tutorial_lesson_autoflag_hint_2(),
      },
    ],
  },
  {
    id: 'chord',
    title: () => m.minesweeper_tutorial_lesson_chord_title(),
    body: () => m.minesweeper_tutorial_lesson_chord_body(),
    rows: ['F1.', '121', '.1F'],
    goal: {
      reveal: [
        [2, 0],
        [0, 2],
      ],
      flag: [],
    },
    hints: [
      {
        numbers: [[1, 1]],
        marks: [mine([0, 0, 1, 1], [2, 2, 1, 1])],
        text: () => m.minesweeper_tutorial_lesson_chord_hint_1(),
      },
      {
        numbers: [[1, 1]],
        marks: [safe([2, 0, 1, 1], [0, 2, 1, 1])],
        text: () => m.minesweeper_tutorial_lesson_chord_hint_2(),
      },
    ],
  },
  {
    id: 'counter',
    title: () => m.minesweeper_tutorial_lesson_counter_title(),
    body: () => m.minesweeper_tutorial_lesson_counter_body(),
    rows: ['1...', '1#..', '1...'],
    goal: {
      reveal: [
        [1, 0],
        [1, 2],
        [2, 0],
        [2, 1],
        [2, 2],
        [3, 0],
        [3, 1],
        [3, 2],
      ],
      flag: [[1, 1]],
    },
    hints: [
      {
        numbers: [
          [0, 0],
          [0, 1],
          [0, 2],
        ],
        marks: [group(1, [1, 0, 1, 3])],
        text: () => m.minesweeper_tutorial_lesson_counter_hint_1(),
      },
      {
        numbers: [
          [0, 0],
          [0, 2],
        ],
        marks: [mine([1, 1, 1, 1]), safe([1, 0, 1, 1], [1, 2, 1, 1])],
        text: () => m.minesweeper_tutorial_lesson_counter_hint_2(),
      },
      {
        numbers: [],
        marks: [safe([1, 0, 1, 1], [1, 2, 1, 1], [2, 0, 2, 3])],
        text: () => m.minesweeper_tutorial_lesson_counter_hint_3(),
      },
    ],
  },
];

/**
 * Whether the board satisfies the goal: every cell to open is open (and safe - a mine would have ended
 * the game), every cell to flag is flagged, and nothing is flagged that is not a mine. A wrong flag keeps
 * a lesson open: the point is the deduction, so a guess that happened to work is not a pass.
 */
export function lessonDone(board: MinesweeperBoard, goal: LessonGoal): boolean {
  const at = ([x, y]: Coord) => board.cells[y * board.width + x];
  if (board.status === 'lost') return false;
  if (!goal.reveal.every((c) => at(c).state === 'revealed' && !at(c).mine)) return false;
  if (!goal.flag.every((c) => at(c).state === 'flagged')) return false;
  return board.cells.every((cell) => cell.state !== 'flagged' || cell.mine);
}
