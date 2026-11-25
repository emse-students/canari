import { m } from '$lib/paraglide/messages';
import type { MinesweeperBoard } from '../game';

/**
 * THE TUTORIAL'S LESSONS (owner, 2026-11-25: *"une section tutoriel qui explique le fonctionnement du
 * demineur avec des mini-grilles"*, with *"un bouton d'indications"* that circles in yellow the groups
 * of cells that justify a pattern). A lesson is a picture ({@link boardFromLayout}), a goal, and the
 * steps of its explanation. The pictures are TEXT, and `lessons.test.ts` proves each one: every cell a
 * lesson asks the player to open is safe, and every cell it asks them to flag is a mine, in EVERY
 * arrangement of mines the visible numbers allow - so a pattern cannot be taught wrong.
 */

/** A cell, as `[x, y]`. */
export type Coord = readonly [number, number];

/** What a lesson asks: cells to open (all safe) and cells to flag (all mines). */
export interface LessonGoal {
  reveal: readonly Coord[];
  flag: readonly Coord[];
}

/**
 * One step of the "Indices" button: the NUMBER(s) the reasoning reads (ringed) and the hidden cells they
 * speak about (the group, tinted), with what to conclude. Authored, not computed: a step explains a
 * pattern, and the order a person reads it in is a teaching choice.
 */
export interface HintStep {
  numbers: readonly Coord[];
  group: readonly Coord[];
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
   * Cells lit from the start, before any hint: a lesson that teaches a GESTURE (open a cell) shows where.
   * Such a lesson has no deduction to verify, only a safe target.
   */
  guide?: readonly Coord[];
  hints: readonly HintStep[];
}

export const LESSONS: readonly Lesson[] = [
  {
    id: 'reveal',
    title: () => m.minesweeper_tutorial_lesson_reveal_title(),
    body: () => m.minesweeper_tutorial_lesson_reveal_body(),
    rows: ['.....', '.....', '.#...', '....#'],
    goal: { reveal: [[0, 0]], flag: [] },
    guide: [[0, 0]],
    hints: [
      {
        numbers: [],
        group: [[0, 0]],
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
        group: [[2, 2]],
        text: () => m.minesweeper_tutorial_lesson_flag_hint_1(),
      },
      {
        numbers: [
          [1, 2],
          [2, 1],
        ],
        group: [[2, 2]],
        text: () => m.minesweeper_tutorial_lesson_flag_hint_2(),
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
        group: [
          [0, 0],
          [2, 2],
        ],
        text: () => m.minesweeper_tutorial_lesson_chord_hint_1(),
      },
      {
        numbers: [[1, 1]],
        group: [
          [2, 0],
          [0, 2],
        ],
        text: () => m.minesweeper_tutorial_lesson_chord_hint_2(),
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
        numbers: [
          [0, 0],
          [1, 0],
        ],
        group: [
          [0, 1],
          [1, 1],
          [2, 1],
        ],
        text: () => m.minesweeper_tutorial_lesson_one_one_hint_1(),
      },
      {
        numbers: [[3, 0]],
        group: [
          [2, 1],
          [3, 1],
        ],
        text: () => m.minesweeper_tutorial_lesson_one_one_hint_2(),
      },
      {
        numbers: [[2, 0]],
        group: [
          [1, 1],
          [2, 1],
          [3, 1],
        ],
        text: () => m.minesweeper_tutorial_lesson_one_one_hint_3(),
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
        group: [
          [0, 1],
          [1, 1],
          [2, 1],
        ],
        text: () => m.minesweeper_tutorial_lesson_one_two_one_hint_1(),
      },
      {
        numbers: [
          [0, 0],
          [2, 0],
        ],
        group: [
          [0, 1],
          [1, 1],
          [2, 1],
        ],
        text: () => m.minesweeper_tutorial_lesson_one_two_one_hint_2(),
      },
      {
        numbers: [[1, 0]],
        group: [[1, 1]],
        text: () => m.minesweeper_tutorial_lesson_one_two_one_hint_3(),
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
        group: [
          [0, 1],
          [1, 1],
          [2, 1],
          [3, 1],
        ],
        text: () => m.minesweeper_tutorial_lesson_one_two_two_one_hint_1(),
      },
      {
        numbers: [[1, 0]],
        group: [
          [0, 1],
          [1, 1],
          [2, 1],
        ],
        text: () => m.minesweeper_tutorial_lesson_one_two_two_one_hint_2(),
      },
      {
        numbers: [[2, 0]],
        group: [
          [1, 1],
          [2, 1],
          [3, 1],
        ],
        text: () => m.minesweeper_tutorial_lesson_one_two_two_one_hint_3(),
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
