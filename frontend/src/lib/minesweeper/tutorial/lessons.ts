import { m } from '$lib/paraglide/messages';
import type { MinesweeperBoard } from '../game';

/**
 * THE TUTORIAL'S LESSONS (owner, 2026-11-25: *"une section tutoriel qui explique le fonctionnement du
 * demineur avec des mini-grilles"*, with a hint button that SHOWS the reasoning). A lesson is a picture
 * ({@link boardFromLayout}), a goal, and the steps of its explanation. The pictures are TEXT, and
 * `lessons.test.ts` proves each one against EVERY arrangement of mines the visible numbers AND the mines
 * counter allow: what a lesson asks to open is safe, what it asks to flag is a mine, nothing the numbers
 * force is left unasked, and every highlight says something true - so a pattern cannot be taught wrong.
 */

/** A cell, as `[x, y]`. */
export type Coord = readonly [number, number];

/** A rectangle of cells: `[x, y, width, height]`. */
type Rect = readonly [number, number, number, number];

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
  text: () => string;
}

export interface Lesson {
  id: string;
  title: () => string;
  body: () => string;
  /** The picture, see `layout.ts`. */
  rows: readonly string[];
  goal: LessonGoal;
  /**
   * Marks shown from the start, before any hint: a lesson that teaches a GESTURE (open a cell) shows
   * where. Such a lesson has no deduction to verify, only a safe target.
   */
  guide?: readonly HintMark[];
  /**
   * For a CORNER pattern: the number whose reasoning the lesson teaches, and the cell it decides. The test
   * holds the picture to it (owner, 2026-11-26): no number may settle its own neighbours (a 0, or as many
   * mines as hidden neighbours - a board edge makes that easy), and that cell must be forced WITH the
   * number and NOT without it, so the pattern cannot be bypassed.
   */
  corner?: { number: Coord; cell: Coord };
  hints: readonly HintStep[];
}

const mine = (...rects: Rect[]): HintMark => ({ kind: 'mine', rects });
const safe = (...rects: Rect[]): HintMark => ({ kind: 'safe', rects });
const group = (count: number | undefined, ...rects: Rect[]): HintMark => ({
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
  {
    id: 'one_one',
    title: () => m.minesweeper_tutorial_lesson_one_one_title(),
    body: () => m.minesweeper_tutorial_lesson_one_one_body(),
    rows: ['1111', '#..#'],
    goal: {
      reveal: [
        [1, 1],
        [2, 1],
      ],
      flag: [
        [0, 1],
        [3, 1],
      ],
    },
    hints: [
      {
        numbers: [[0, 0]],
        marks: [group(1, [0, 1, 2, 1])],
        text: () => m.minesweeper_tutorial_lesson_one_one_hint_1(),
      },
      {
        numbers: [[1, 0]],
        marks: [group(1, [0, 1, 2, 1]), safe([2, 1, 1, 1])],
        text: () => m.minesweeper_tutorial_lesson_one_one_hint_2(),
      },
      {
        numbers: [[3, 0]],
        marks: [safe([2, 1, 1, 1]), mine([3, 1, 1, 1])],
        text: () => m.minesweeper_tutorial_lesson_one_one_hint_3(),
      },
      {
        numbers: [[2, 0]],
        marks: [mine([0, 1, 1, 1], [3, 1, 1, 1]), safe([1, 1, 2, 1])],
        text: () => m.minesweeper_tutorial_lesson_one_one_hint_4(),
      },
    ],
  },
  {
    id: 'one_two_one',
    title: () => m.minesweeper_tutorial_lesson_one_two_one_title(),
    body: () => m.minesweeper_tutorial_lesson_one_two_one_body(),
    rows: ['121', '#.#'],
    goal: {
      reveal: [[1, 1]],
      flag: [
        [0, 1],
        [2, 1],
      ],
    },
    hints: [
      {
        numbers: [[1, 0]],
        marks: [group(2, [0, 1, 3, 1])],
        text: () => m.minesweeper_tutorial_lesson_one_two_one_hint_1(),
      },
      {
        numbers: [[0, 0]],
        marks: [group(1, [0, 1, 2, 1])],
        text: () => m.minesweeper_tutorial_lesson_one_two_one_hint_2(),
      },
      {
        numbers: [[2, 0]],
        marks: [group(1, [1, 1, 2, 1])],
        text: () => m.minesweeper_tutorial_lesson_one_two_one_hint_3(),
      },
      {
        numbers: [[1, 0]],
        marks: [mine([0, 1, 1, 1], [2, 1, 1, 1]), safe([1, 1, 1, 1])],
        text: () => m.minesweeper_tutorial_lesson_one_two_one_hint_4(),
      },
    ],
  },
  {
    id: 'one_two_two_one',
    title: () => m.minesweeper_tutorial_lesson_one_two_two_one_title(),
    body: () => m.minesweeper_tutorial_lesson_one_two_two_one_body(),
    rows: ['1221', '.##.'],
    goal: {
      reveal: [
        [0, 1],
        [3, 1],
      ],
      flag: [
        [1, 1],
        [2, 1],
      ],
    },
    hints: [
      {
        numbers: [
          [0, 0],
          [3, 0],
        ],
        marks: [group(1, [0, 1, 2, 1]), group(1, [2, 1, 2, 1])],
        text: () => m.minesweeper_tutorial_lesson_one_two_two_one_hint_1(),
      },
      {
        numbers: [[1, 0]],
        marks: [group(1, [0, 1, 2, 1]), mine([2, 1, 1, 1])],
        text: () => m.minesweeper_tutorial_lesson_one_two_two_one_hint_2(),
      },
      {
        numbers: [[2, 0]],
        marks: [group(1, [2, 1, 2, 1]), mine([1, 1, 1, 1])],
        text: () => m.minesweeper_tutorial_lesson_one_two_two_one_hint_3(),
      },
      {
        numbers: [],
        marks: [mine([1, 1, 2, 1]), safe([0, 1, 1, 1], [3, 1, 1, 1])],
        text: () => m.minesweeper_tutorial_lesson_one_two_two_one_hint_4(),
      },
    ],
  },
  {
    id: 'angle_one_three_one',
    title: () => m.minesweeper_tutorial_lesson_angle_one_three_one_title(),
    body: () => m.minesweeper_tutorial_lesson_angle_one_three_one_body(),
    // OPEN: the column on the right is still hidden and no number touches it, so neither a board edge
    // nor the mines counter can stand in for the corner reasoning (`lessons.test.ts` proves it).
    rows: ['0001##', '0001..', '0001..', '1113#.', '#..##.'],
    goal: {
      reveal: [
        [4, 1],
        [4, 2],
        [1, 4],
        [2, 4],
      ],
      flag: [
        [4, 0],
        [4, 3],
        [0, 4],
        [3, 4],
        [4, 4],
      ],
    },
    corner: { number: [3, 3], cell: [4, 4] },
    hints: [
      {
        numbers: [[3, 3]],
        marks: [group(3, [4, 2, 1, 3], [2, 4, 2, 1])],
        text: () => m.minesweeper_tutorial_lesson_angle_one_three_one_hint_1(),
      },
      {
        numbers: [
          [3, 2],
          [2, 3],
        ],
        marks: [group(1, [4, 1, 1, 3]), group(1, [1, 4, 3, 1])],
        text: () => m.minesweeper_tutorial_lesson_angle_one_three_one_hint_2(),
      },
      {
        numbers: [[3, 3]],
        marks: [mine([4, 4, 1, 1]), safe([4, 1, 1, 1], [1, 4, 1, 1])],
        text: () => m.minesweeper_tutorial_lesson_angle_one_three_one_hint_3(),
      },
      {
        numbers: [],
        marks: [
          mine([4, 0, 1, 1], [4, 3, 1, 1], [0, 4, 1, 1], [3, 4, 1, 1], [4, 4, 1, 1]),
          safe([4, 1, 1, 2], [1, 4, 2, 1]),
        ],
        text: () => m.minesweeper_tutorial_lesson_angle_one_three_one_hint_4(),
      },
    ],
  },
  {
    id: 'angle_two_two_two',
    title: () => m.minesweeper_tutorial_lesson_angle_two_two_two_title(),
    body: () => m.minesweeper_tutorial_lesson_angle_two_two_two_body(),
    rows: ['0001.#', '0001#.', '0002..', '1122#.', '.#.#..'],
    goal: {
      reveal: [
        [4, 0],
        [4, 2],
        [0, 4],
        [2, 4],
        [4, 4],
      ],
      flag: [
        [4, 1],
        [4, 3],
        [1, 4],
        [3, 4],
      ],
    },
    corner: { number: [3, 3], cell: [4, 4] },
    hints: [
      {
        numbers: [
          [3, 2],
          [2, 3],
        ],
        marks: [group(2, [4, 1, 1, 3]), group(2, [1, 4, 3, 1])],
        text: () => m.minesweeper_tutorial_lesson_angle_two_two_two_hint_1(),
      },
      {
        numbers: [[3, 3]],
        marks: [group(2, [4, 2, 1, 3], [2, 4, 2, 1])],
        text: () => m.minesweeper_tutorial_lesson_angle_two_two_two_hint_2(),
      },
      {
        numbers: [
          [3, 2],
          [2, 3],
        ],
        marks: [group(undefined, [4, 2, 1, 2]), group(undefined, [2, 4, 2, 1])],
        text: () => m.minesweeper_tutorial_lesson_angle_two_two_two_hint_3(),
      },
      {
        numbers: [[3, 3]],
        marks: [safe([4, 4, 1, 1]), mine([4, 1, 1, 1], [1, 4, 1, 1])],
        text: () => m.minesweeper_tutorial_lesson_angle_two_two_two_hint_4(),
      },
      {
        numbers: [],
        marks: [
          mine([4, 1, 1, 1], [4, 3, 1, 1], [1, 4, 1, 1], [3, 4, 1, 1]),
          safe([4, 0, 1, 1], [4, 2, 1, 1], [0, 4, 1, 1], [2, 4, 1, 1], [4, 4, 1, 1]),
        ],
        text: () => m.minesweeper_tutorial_lesson_angle_two_two_two_hint_5(),
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
