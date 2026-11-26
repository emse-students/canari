import { m } from '$lib/paraglide/messages';
import { group, mine, safe, type Lesson } from './lessons';

/**
 * THE PATTERN CATALOGUE, the tutorial's ANNEX (owner, 2026-11-26: *"reprend leurs explications pour tous
 * les patterns dans un tutoriel annexe"*, then *"utilise ceux de minesweeper.online tels quels"*). Every
 * pattern of the reference catalogue (minesweeper.online, "Patterns"), in the reference's own order and
 * families, one playable board each: the basic patterns, the reduction of a number by its flags, the holes, the
 * triangles, the high complexity patterns and the last turns.
 *
 * **The pictures are the reference's**: each board keeps the shape of the reference diagram - which cells are
 * open, which are hidden, where the flags are, which cells the explanation groups - and each hint follows the
 * reference's own steps, in our own words (see the wiki page for the credit). Where a diagram is a crop of a larger
 * board, its edges are closed so the picture is consistent, and the numbers at a closed edge are recomputed from
 * the board: the reference's own are those of the board beyond the crop. Every board is PROVED by
 * `lessons.test.ts` like a tutorial lesson - what it asks to open is safe, what it asks to flag is a mine, and every
 * highlight is true in every arrangement the numbers allow. Two entries are ours: the introduction to reduction,
 * and the two corner patterns, which the reference draws as pictures with numbers its own picture cannot hold -
 * their boards are the open ones proved earlier, turned to the reference's orientation.
 *
 * `partial`: the picture is a window, so it holds more than the pattern asks - the goal is what the pattern
 * concludes, which the test holds to be forced, not everything the neighbouring numbers force.
 */

const SECTION = {
  basics: () => m.minesweeper_patterns_section_basics(),
  reduction: () => m.minesweeper_patterns_section_reduction(),
  holes: () => m.minesweeper_patterns_section_holes(),
  triangles: () => m.minesweeper_patterns_section_triangles(),
  complex: () => m.minesweeper_patterns_section_complex(),
  endgame: () => m.minesweeper_patterns_section_endgame(),
};

export const PATTERNS: readonly Lesson[] = [
  {
    id: 'basic_mines',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_basic_mines_title(),
    body: () => m.minesweeper_pattern_basic_mines_body(),
    rows: ['001..', '002#.', '003#.', '112#.', '#....'],
    open: true,
    partial: true,
    goal: {
      reveal: [],
      flag: [
        [3, 1],
        [3, 2],
        [3, 3],
      ],
    },
    hints: [
      {
        numbers: [[2, 2]],
        marks: [group(3, [3, 1, 1, 3])],
        text: () => m.minesweeper_pattern_basic_mines_hint_1(),
      },
      {
        numbers: [[2, 2]],
        marks: [mine([3, 1, 1, 3])],
        text: () => m.minesweeper_pattern_basic_mines_hint_2(),
      },
    ],
  },
  {
    id: 'basic_flags',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_basic_flags_title(),
    body: () => m.minesweeper_pattern_basic_flags_body(),
    rows: ['002F.', '003F.', '112F.', '#....', '.....'],
    open: true,
    partial: true,
    goal: {
      reveal: [
        [1, 3],
        [2, 3],
        [3, 3],
      ],
      flag: [],
    },
    hints: [
      {
        numbers: [[2, 2]],
        marks: [mine([3, 1, 1, 2])],
        text: () => m.minesweeper_pattern_basic_flags_hint_1(),
      },
      {
        numbers: [[2, 2]],
        marks: [safe([1, 3, 3, 1])],
        text: () => m.minesweeper_pattern_basic_flags_hint_2(),
      },
    ],
  },
  {
    id: 'one_one',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_one_one_title(),
    body: () => m.minesweeper_pattern_one_one_body(),
    rows: ['.....', '.#..#', '11111', '00000', '00000'],
    open: true,
    partial: true,
    goal: {
      reveal: [[2, 1]],
      flag: [],
    },
    hints: [
      {
        numbers: [[0, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_one_one_hint_1(),
      },
      {
        numbers: [[0, 2]],
        marks: [group(1, [0, 1, 2, 1])],
        text: () => m.minesweeper_pattern_one_one_hint_2(),
      },
      {
        numbers: [[1, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_one_one_hint_3(),
      },
      {
        numbers: [[1, 2]],
        marks: [group(1, [0, 1, 2, 1]), safe([2, 1, 1, 1])],
        text: () => m.minesweeper_pattern_one_one_hint_4(),
      },
    ],
  },
  {
    id: 'one_one_plus',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_one_one_plus_title(),
    body: () => m.minesweeper_pattern_one_one_plus_body(),
    rows: ['....', '.#..', '11..', '01..', '01#.'],
    open: true,
    partial: true,
    goal: {
      reveal: [
        [2, 1],
        [2, 2],
        [2, 3],
      ],
      flag: [],
    },
    hints: [
      {
        numbers: [[0, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_one_one_plus_hint_1(),
      },
      {
        numbers: [[0, 2]],
        marks: [group(1, [0, 1, 2, 1])],
        text: () => m.minesweeper_pattern_one_one_plus_hint_2(),
      },
      {
        numbers: [[1, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_one_one_plus_hint_3(),
      },
      {
        numbers: [[1, 2]],
        marks: [group(1, [0, 1, 2, 1]), safe([2, 1, 1, 3])],
        text: () => m.minesweeper_pattern_one_one_plus_hint_4(),
      },
    ],
  },
  {
    id: 'one_two',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_one_two_title(),
    body: () => m.minesweeper_pattern_one_two_body(),
    rows: ['....', '#.#.', '1211', '0000', '0000'],
    open: true,
    partial: true,
    goal: {
      reveal: [],
      flag: [[2, 1]],
    },
    hints: [
      {
        numbers: [[0, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_one_two_hint_1(),
      },
      {
        numbers: [[0, 2]],
        marks: [group(1, [0, 1, 2, 1])],
        text: () => m.minesweeper_pattern_one_two_hint_2(),
      },
      {
        numbers: [[1, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_one_two_hint_3(),
      },
      {
        numbers: [[1, 2]],
        marks: [group(1, [0, 1, 2, 1]), mine([2, 1, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_hint_4(),
      },
    ],
  },
  {
    id: 'one_two_plus',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_one_two_plus_title(),
    body: () => m.minesweeper_pattern_one_two_plus_body(),
    rows: ['....', '.##.', '14#.', '02#.', '01..'],
    open: true,
    partial: true,
    goal: {
      reveal: [],
      flag: [
        [2, 1],
        [2, 2],
        [2, 3],
      ],
    },
    hints: [
      {
        numbers: [[0, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_one_two_plus_hint_1(),
      },
      {
        numbers: [[0, 2]],
        marks: [group(1, [0, 1, 2, 1])],
        text: () => m.minesweeper_pattern_one_two_plus_hint_2(),
      },
      {
        numbers: [[1, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_one_two_plus_hint_3(),
      },
      {
        numbers: [[1, 2]],
        marks: [group(1, [0, 1, 2, 1]), mine([2, 1, 1, 3])],
        text: () => m.minesweeper_pattern_one_two_plus_hint_4(),
      },
    ],
  },
  {
    id: 'one_two_c',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_one_two_c_title(),
    body: () => m.minesweeper_pattern_one_two_c_body(),
    rows: ['......', '..#.#.', '#3123#', '#2002#'],
    open: true,
    partial: true,
    goal: {
      reveal: [],
      flag: [[4, 1]],
    },
    hints: [
      {
        numbers: [[2, 2]],
        marks: [group(undefined, [2, 1, 2, 1])],
        text: () => m.minesweeper_pattern_one_two_c_hint_1(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(undefined, [2, 1, 2, 1])],
        text: () => m.minesweeper_pattern_one_two_c_hint_2(),
      },
      {
        numbers: [[3, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_one_two_c_hint_3(),
      },
      {
        numbers: [[3, 2]],
        marks: [group(undefined, [2, 1, 2, 1]), mine([4, 1, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_c_hint_4(),
      },
    ],
  },
  {
    id: 'one_two_c_plus',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_one_two_c_plus_title(),
    body: () => m.minesweeper_pattern_one_two_c_plus_body(),
    rows: ['.....', '.#.#.', '114#.', '002#.', '001..'],
    open: true,
    partial: true,
    goal: {
      reveal: [],
      flag: [
        [3, 1],
        [3, 2],
        [3, 3],
      ],
    },
    hints: [
      {
        numbers: [[1, 2]],
        marks: [group(undefined, [1, 1, 2, 1])],
        text: () => m.minesweeper_pattern_one_two_c_plus_hint_1(),
      },
      {
        numbers: [[1, 2]],
        marks: [group(undefined, [1, 1, 2, 1])],
        text: () => m.minesweeper_pattern_one_two_c_plus_hint_2(),
      },
      {
        numbers: [[2, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_one_two_c_plus_hint_3(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(undefined, [1, 1, 2, 1]), mine([3, 1, 1, 3])],
        text: () => m.minesweeper_pattern_one_two_c_plus_hint_4(),
      },
    ],
  },
  {
    id: 'one_two_one',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_one_two_one_title(),
    body: () => m.minesweeper_pattern_one_two_one_body(),
    rows: ['...', '#.#', '121', '000', '000'],
    open: true,
    partial: true,
    goal: {
      reveal: [[1, 1]],
      flag: [
        [0, 1],
        [2, 1],
      ],
    },
    hints: [
      {
        numbers: [
          [0, 2],
          [1, 2],
        ],
        marks: [group(1, [0, 1, 2, 1]), mine([2, 1, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_one_hint_1(),
      },
      {
        numbers: [
          [1, 2],
          [2, 2],
        ],
        marks: [group(1, [1, 1, 2, 1]), mine([0, 1, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_one_hint_2(),
      },
      {
        numbers: [[1, 2]],
        marks: [mine([0, 1, 1, 1], [2, 1, 1, 1]), safe([1, 1, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_one_hint_3(),
      },
    ],
  },
  {
    id: 'one_two_two_one',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_one_two_two_one_title(),
    body: () => m.minesweeper_pattern_one_two_two_one_body(),
    rows: ['....', '.##.', '1221', '0000', '0000'],
    open: true,
    partial: true,
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
          [0, 2],
          [1, 2],
        ],
        marks: [group(1, [0, 1, 2, 1]), mine([2, 1, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_two_one_hint_1(),
      },
      {
        numbers: [
          [2, 2],
          [3, 2],
        ],
        marks: [group(1, [2, 1, 2, 1]), mine([1, 1, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_two_one_hint_2(),
      },
      {
        numbers: [],
        marks: [mine([1, 1, 2, 1]), safe([0, 1, 1, 1], [3, 1, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_two_one_hint_3(),
      },
    ],
  },
  {
    id: 'reduction_intro',
    section: SECTION.reduction,
    title: () => m.minesweeper_pattern_reduction_intro_title(),
    body: () => m.minesweeper_pattern_reduction_intro_body(),
    rows: ['22', 'F#'],
    goal: {
      reveal: [],
      flag: [[1, 1]],
    },
    hints: [
      {
        numbers: [
          [0, 0],
          [1, 0],
        ],
        marks: [mine([0, 1, 1, 1])],
        reduced: [
          { cell: [0, 0], value: 1 },
          { cell: [1, 0], value: 1 },
        ],
        text: () => m.minesweeper_pattern_reduction_intro_hint_1(),
      },
      {
        numbers: [[0, 0]],
        marks: [mine([1, 1, 1, 1])],
        text: () => m.minesweeper_pattern_reduction_intro_hint_2(),
      },
    ],
  },
  {
    id: 'reduced_one_one',
    section: SECTION.reduction,
    title: () => m.minesweeper_pattern_reduced_one_one_title(),
    body: () => m.minesweeper_pattern_reduced_one_one_body(),
    rows: ['01#..', '12...', 'F2...', '34#..', 'FF22#'],
    open: true,
    partial: true,
    goal: {
      reveal: [[2, 1]],
      flag: [],
    },
    hints: [
      {
        numbers: [[1, 2]],
        marks: [],
        reduced: [{ cell: [1, 2], value: 1 }],
        text: () => m.minesweeper_pattern_reduced_one_one_hint_1(),
      },
      {
        numbers: [[1, 3]],
        marks: [],
        reduced: [{ cell: [1, 3], value: 1 }],
        text: () => m.minesweeper_pattern_reduced_one_one_hint_2(),
      },
      {
        numbers: [
          [1, 2],
          [1, 3],
        ],
        marks: [group(1, [2, 2, 1, 2]), safe([2, 1, 1, 1])],
        reduced: [
          { cell: [1, 2], value: 1 },
          { cell: [1, 3], value: 1 },
        ],
        text: () => m.minesweeper_pattern_reduced_one_one_hint_3(),
      },
    ],
  },
  {
    id: 'reduced_one_two',
    section: SECTION.reduction,
    title: () => m.minesweeper_pattern_reduced_one_two_title(),
    body: () => m.minesweeper_pattern_reduced_one_two_body(),
    rows: ['FF11F', '#4233', '#..##', '.....'],
    open: true,
    partial: true,
    goal: {
      reveal: [],
      flag: [[4, 2]],
    },
    hints: [
      {
        numbers: [[2, 1]],
        marks: [],
        reduced: [{ cell: [2, 1], value: 1 }],
        text: () => m.minesweeper_pattern_reduced_one_two_hint_1(),
      },
      {
        numbers: [[3, 1]],
        marks: [],
        reduced: [{ cell: [3, 1], value: 2 }],
        text: () => m.minesweeper_pattern_reduced_one_two_hint_2(),
      },
      {
        numbers: [
          [2, 1],
          [3, 1],
        ],
        marks: [group(undefined, [2, 2, 2, 1]), mine([4, 2, 1, 1])],
        reduced: [
          { cell: [2, 1], value: 1 },
          { cell: [3, 1], value: 2 },
        ],
        text: () => m.minesweeper_pattern_reduced_one_two_hint_3(),
      },
    ],
  },
  {
    id: 'reduced_one_two_one',
    section: SECTION.reduction,
    title: () => m.minesweeper_pattern_reduced_one_two_one_title(),
    body: () => m.minesweeper_pattern_reduced_one_two_one_body(),
    rows: ['.....', '.#.#.', '12321', '01F10', '01110'],
    open: true,
    partial: true,
    goal: {
      reveal: [[2, 1]],
      flag: [
        [1, 1],
        [3, 1],
      ],
    },
    hints: [
      {
        numbers: [
          [1, 2],
          [2, 2],
          [3, 2],
        ],
        marks: [mine([1, 1, 1, 1], [3, 1, 1, 1]), safe([2, 1, 1, 1])],
        reduced: [
          { cell: [1, 2], value: 1 },
          { cell: [2, 2], value: 2 },
          { cell: [3, 2], value: 1 },
        ],
        text: () => m.minesweeper_pattern_reduced_one_two_one_hint_1(),
      },
    ],
  },
  {
    id: 'hole_1',
    section: SECTION.holes,
    title: () => m.minesweeper_pattern_hole_1_title(),
    body: () => m.minesweeper_pattern_hole_1_body(),
    rows: ['.....', '.....', '.#1.#', '11111', '00000'],
    open: true,
    partial: true,
    goal: {
      reveal: [
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      flag: [],
    },
    hints: [
      {
        numbers: [[2, 3]],
        marks: [],
        text: () => m.minesweeper_pattern_hole_1_hint_1(),
      },
      {
        numbers: [[2, 3]],
        marks: [group(1, [1, 2, 1, 1], [3, 2, 1, 1])],
        text: () => m.minesweeper_pattern_hole_1_hint_2(),
      },
      {
        numbers: [[2, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_hole_1_hint_3(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(1, [1, 2, 1, 1], [3, 2, 1, 1]), safe([1, 1, 3, 1])],
        text: () => m.minesweeper_pattern_hole_1_hint_4(),
      },
    ],
  },
  {
    id: 'hole_2',
    section: SECTION.holes,
    title: () => m.minesweeper_pattern_hole_2_title(),
    body: () => m.minesweeper_pattern_hole_2_body(),
    rows: ['....#', '#213#', '.#1.#', '11111', '00000'],
    open: true,
    partial: true,
    goal: {
      reveal: [
        [1, 0],
        [2, 0],
        [3, 0],
      ],
      flag: [],
    },
    hints: [
      {
        numbers: [[2, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_hole_2_hint_1(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(1, [1, 2, 1, 1], [3, 2, 1, 1])],
        text: () => m.minesweeper_pattern_hole_2_hint_2(),
      },
      {
        numbers: [[2, 1]],
        marks: [],
        text: () => m.minesweeper_pattern_hole_2_hint_3(),
      },
      {
        numbers: [[2, 1]],
        marks: [group(1, [1, 2, 1, 1], [3, 2, 1, 1]), safe([1, 0, 3, 1])],
        text: () => m.minesweeper_pattern_hole_2_hint_4(),
      },
    ],
  },
  {
    id: 'hole_3',
    section: SECTION.holes,
    title: () => m.minesweeper_pattern_hole_3_title(),
    body: () => m.minesweeper_pattern_hole_3_body(),
    rows: ['.#...', '.221.', '.#1.#', '11111', '00000'],
    open: true,
    partial: true,
    goal: {
      reveal: [
        [2, 0],
        [3, 0],
        [4, 0],
        [4, 1],
      ],
      flag: [],
    },
    hints: [
      {
        numbers: [[3, 3]],
        marks: [],
        text: () => m.minesweeper_pattern_hole_3_hint_1(),
      },
      {
        numbers: [[3, 3]],
        marks: [group(1, [3, 2, 2, 1])],
        text: () => m.minesweeper_pattern_hole_3_hint_2(),
      },
      {
        numbers: [[3, 1]],
        marks: [],
        text: () => m.minesweeper_pattern_hole_3_hint_3(),
      },
      {
        numbers: [[3, 1]],
        marks: [group(1, [3, 2, 2, 1]), safe([2, 0, 3, 1], [4, 1, 1, 1])],
        text: () => m.minesweeper_pattern_hole_3_hint_4(),
      },
    ],
  },
  {
    id: 'triangle_1',
    section: SECTION.triangles,
    title: () => m.minesweeper_pattern_triangle_1_title(),
    body: () => m.minesweeper_pattern_triangle_1_body(),
    rows: ['.....', '.....', '..1.#', '.#111', '#2100'],
    open: true,
    partial: true,
    goal: {
      reveal: [
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      flag: [],
    },
    hints: [
      {
        numbers: [[2, 3]],
        marks: [],
        text: () => m.minesweeper_pattern_triangle_1_hint_1(),
      },
      {
        numbers: [[2, 3]],
        marks: [group(1, [1, 2, 1, 2], [3, 2, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_1_hint_2(),
      },
      {
        numbers: [[2, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_triangle_1_hint_3(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(1, [1, 2, 1, 2], [3, 2, 1, 1]), safe([1, 1, 3, 1])],
        text: () => m.minesweeper_pattern_triangle_1_hint_4(),
      },
    ],
  },
  {
    id: 'triangle_2',
    section: SECTION.triangles,
    title: () => m.minesweeper_pattern_triangle_2_title(),
    body: () => m.minesweeper_pattern_triangle_2_body(),
    rows: ['.....', '.....', '.#1.#', '..211', '.#100'],
    open: true,
    partial: true,
    goal: {
      reveal: [
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      flag: [[1, 4]],
    },
    hints: [
      {
        numbers: [[2, 2]],
        marks: [group(undefined, [1, 2, 1, 2], [3, 2, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_2_hint_1(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(undefined, [1, 2, 1, 2], [3, 2, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_2_hint_2(),
      },
      {
        numbers: [[2, 3]],
        marks: [],
        text: () => m.minesweeper_pattern_triangle_2_hint_3(),
      },
      {
        numbers: [[2, 3]],
        marks: [group(undefined, [1, 2, 1, 2], [3, 2, 1, 1]), mine([1, 4, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_2_hint_4(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(1, [1, 2, 1, 2], [3, 2, 1, 1]), safe([1, 1, 3, 1])],
        text: () => m.minesweeper_pattern_triangle_2_hint_5(),
      },
    ],
  },
  {
    id: 'triangle_3',
    section: SECTION.triangles,
    title: () => m.minesweeper_pattern_triangle_3_title(),
    body: () => m.minesweeper_pattern_triangle_3_body(),
    rows: ['.....', '.....', '.#2.#', '.#311', '.#200'],
    open: true,
    partial: true,
    goal: {
      reveal: [
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      flag: [[1, 4]],
    },
    hints: [
      {
        numbers: [[2, 2]],
        marks: [group(undefined, [1, 2, 1, 2], [3, 2, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_3_hint_1(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(undefined, [1, 2, 1, 2], [3, 2, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_3_hint_2(),
      },
      {
        numbers: [[2, 3]],
        marks: [],
        text: () => m.minesweeper_pattern_triangle_3_hint_3(),
      },
      {
        numbers: [[2, 3]],
        marks: [group(undefined, [1, 2, 1, 2], [3, 2, 1, 1]), mine([1, 4, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_3_hint_4(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(2, [1, 2, 1, 2], [3, 2, 1, 1]), safe([1, 1, 3, 1])],
        text: () => m.minesweeper_pattern_triangle_3_hint_5(),
      },
    ],
  },
  {
    id: 'triangle_4',
    section: SECTION.triangles,
    title: () => m.minesweeper_pattern_triangle_4_title(),
    body: () => m.minesweeper_pattern_triangle_4_body(),
    rows: ['.....', '.###.', '.243.', '..1#.', '..111'],
    open: true,
    partial: true,
    goal: {
      reveal: [
        [0, 1],
        [0, 2],
        [0, 3],
      ],
      flag: [
        [3, 1],
        [3, 3],
      ],
    },
    hints: [
      {
        numbers: [[1, 2]],
        marks: [group(undefined, [1, 1, 2, 1], [1, 3, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_4_hint_1(),
      },
      {
        numbers: [[1, 2]],
        marks: [group(undefined, [1, 1, 2, 1], [1, 3, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_4_hint_2(),
      },
      {
        numbers: [[2, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_triangle_4_hint_3(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(undefined, [1, 1, 2, 1], [1, 3, 1, 1]), mine([3, 1, 1, 1], [3, 3, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_4_hint_4(),
      },
      {
        numbers: [[1, 2]],
        marks: [group(2, [1, 1, 2, 1], [1, 3, 1, 1]), safe([0, 1, 1, 3])],
        text: () => m.minesweeper_pattern_triangle_4_hint_5(),
      },
    ],
  },
  {
    id: 'triangle_5',
    section: SECTION.triangles,
    title: () => m.minesweeper_pattern_triangle_5_title(),
    body: () => m.minesweeper_pattern_triangle_5_body(),
    rows: ['.....', '#....', '#312#', '.#2.#', '.#211'],
    open: true,
    partial: true,
    goal: {
      reveal: [
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      flag: [[1, 4]],
    },
    hints: [
      {
        numbers: [[2, 2]],
        marks: [group(undefined, [1, 3, 1, 1], [3, 3, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_5_hint_1(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(undefined, [1, 3, 1, 1], [3, 3, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_5_hint_2(),
      },
      {
        numbers: [[2, 3]],
        marks: [],
        text: () => m.minesweeper_pattern_triangle_5_hint_3(),
      },
      {
        numbers: [[2, 3]],
        marks: [group(undefined, [1, 3, 1, 1], [3, 3, 1, 1]), mine([1, 4, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_5_hint_4(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(1, [1, 3, 1, 1], [3, 3, 1, 1]), safe([1, 1, 3, 1])],
        text: () => m.minesweeper_pattern_triangle_5_hint_5(),
      },
    ],
  },
  {
    id: 'corner_one_three_one',
    section: SECTION.complex,
    title: () => m.minesweeper_pattern_corner_one_three_one_title(),
    body: () => m.minesweeper_pattern_corner_one_three_one_body(),
    rows: ['#..##.', '1113#.', '0001..', '0001..', '0001##'],
    open: true,
    corner: { number: [3, 1], cell: [4, 0] },
    goal: {
      reveal: [
        [4, 3],
        [4, 2],
        [1, 0],
        [2, 0],
      ],
      flag: [
        [4, 4],
        [4, 1],
        [0, 0],
        [3, 0],
        [4, 0],
      ],
    },
    hints: [
      {
        numbers: [[3, 1]],
        marks: [group(3, [4, 0, 1, 3], [2, 0, 2, 1])],
        text: () => m.minesweeper_pattern_corner_one_three_one_hint_1(),
      },
      {
        numbers: [
          [3, 2],
          [2, 1],
        ],
        marks: [group(1, [4, 1, 1, 3]), group(1, [1, 0, 3, 1])],
        text: () => m.minesweeper_pattern_corner_one_three_one_hint_2(),
      },
      {
        numbers: [[3, 1]],
        marks: [mine([4, 0, 1, 1]), safe([4, 3, 1, 1], [1, 0, 1, 1])],
        text: () => m.minesweeper_pattern_corner_one_three_one_hint_3(),
      },
      {
        numbers: [],
        marks: [
          mine([4, 4, 1, 1], [4, 1, 1, 1], [0, 0, 1, 1], [3, 0, 1, 1], [4, 0, 1, 1]),
          safe([4, 2, 1, 2], [1, 0, 2, 1]),
        ],
        text: () => m.minesweeper_pattern_corner_one_three_one_hint_4(),
      },
    ],
  },
  {
    id: 'corner_two_two_two',
    section: SECTION.complex,
    title: () => m.minesweeper_pattern_corner_two_two_two_title(),
    body: () => m.minesweeper_pattern_corner_two_two_two_body(),
    rows: ['.#.#..', '1122#.', '0002..', '0001#.', '0001.#'],
    open: true,
    corner: { number: [3, 1], cell: [4, 0] },
    goal: {
      reveal: [
        [4, 4],
        [4, 2],
        [0, 0],
        [2, 0],
        [4, 0],
      ],
      flag: [
        [4, 3],
        [4, 1],
        [1, 0],
        [3, 0],
      ],
    },
    hints: [
      {
        numbers: [
          [3, 2],
          [2, 1],
        ],
        marks: [group(2, [4, 1, 1, 3]), group(2, [1, 0, 3, 1])],
        text: () => m.minesweeper_pattern_corner_two_two_two_hint_1(),
      },
      {
        numbers: [[3, 1]],
        marks: [group(2, [4, 0, 1, 3], [2, 0, 2, 1])],
        text: () => m.minesweeper_pattern_corner_two_two_two_hint_2(),
      },
      {
        numbers: [
          [3, 2],
          [2, 1],
        ],
        marks: [group(undefined, [4, 1, 1, 2]), group(undefined, [2, 0, 2, 1])],
        text: () => m.minesweeper_pattern_corner_two_two_two_hint_3(),
      },
      {
        numbers: [[3, 1]],
        marks: [safe([4, 0, 1, 1]), mine([4, 3, 1, 1], [1, 0, 1, 1])],
        text: () => m.minesweeper_pattern_corner_two_two_two_hint_4(),
      },
      {
        numbers: [],
        marks: [
          mine([4, 3, 1, 1], [4, 1, 1, 1], [1, 0, 1, 1], [3, 0, 1, 1]),
          safe([4, 4, 1, 1], [4, 2, 1, 1], [0, 0, 1, 1], [2, 0, 1, 1], [4, 0, 1, 1]),
        ],
        text: () => m.minesweeper_pattern_corner_two_two_two_hint_5(),
      },
    ],
  },
  {
    id: 'gt_two_lt',
    section: SECTION.complex,
    title: () => m.minesweeper_pattern_gt_two_lt_title(),
    body: () => m.minesweeper_pattern_gt_two_lt_body(),
    rows: ['.#..', '11..', '11..', '1#..', '12..', '01#.', '01..'],
    open: true,
    partial: true,
    goal: {
      reveal: [
        [2, 1],
        [2, 2],
        [2, 6],
      ],
      flag: [],
    },
    hints: [
      {
        numbers: [[1, 2]],
        marks: [group(undefined, [1, 3, 2, 1])],
        text: () => m.minesweeper_pattern_gt_two_lt_hint_1(),
      },
      {
        numbers: [[1, 2]],
        marks: [group(undefined, [1, 3, 2, 1])],
        text: () => m.minesweeper_pattern_gt_two_lt_hint_2(),
      },
      {
        numbers: [[1, 5]],
        marks: [group(undefined, [2, 4, 1, 2])],
        text: () => m.minesweeper_pattern_gt_two_lt_hint_3(),
      },
      {
        numbers: [[1, 5]],
        marks: [group(undefined, [2, 4, 1, 2])],
        text: () => m.minesweeper_pattern_gt_two_lt_hint_4(),
      },
      {
        numbers: [[1, 4]],
        marks: [],
        text: () => m.minesweeper_pattern_gt_two_lt_hint_5(),
      },
      {
        numbers: [[1, 4]],
        marks: [group(1, [1, 3, 2, 1]), group(1, [2, 4, 1, 2]), safe([2, 1, 1, 2], [2, 6, 1, 1])],
        text: () => m.minesweeper_pattern_gt_two_lt_hint_6(),
      },
    ],
  },
  {
    id: 't_pattern',
    section: SECTION.complex,
    title: () => m.minesweeper_pattern_t_pattern_title(),
    body: () => m.minesweeper_pattern_t_pattern_body(),
    rows: ['.....', '.##..', '#432.', '.#1.#', '11111', '00000'],
    open: true,
    partial: true,
    goal: {
      reveal: [
        [4, 1],
        [4, 2],
      ],
      flag: [[1, 1]],
    },
    hints: [
      {
        numbers: [[2, 4]],
        marks: [group(1, [1, 3, 1, 1], [3, 3, 1, 1])],
        text: () => m.minesweeper_pattern_t_pattern_hint_1(),
      },
      {
        numbers: [[3, 4]],
        marks: [group(1, [3, 3, 2, 1])],
        text: () => m.minesweeper_pattern_t_pattern_hint_2(),
      },
      {
        numbers: [[3, 2]],
        marks: [group(1, [2, 1, 3, 1], [4, 2, 1, 1])],
        text: () => m.minesweeper_pattern_t_pattern_hint_3(),
      },
      {
        numbers: [[2, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_t_pattern_hint_4(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(1, [1, 3, 1, 1], [3, 3, 1, 1]), mine([1, 1, 1, 1])],
        text: () => m.minesweeper_pattern_t_pattern_hint_5(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(1, [2, 1, 2, 1]), safe([4, 1, 1, 1], [4, 2, 1, 1])],
        text: () => m.minesweeper_pattern_t_pattern_hint_6(),
      },
    ],
  },
  {
    id: 'chain',
    section: SECTION.complex,
    title: () => m.minesweeper_pattern_chain_title(),
    body: () => m.minesweeper_pattern_chain_body(),
    rows: [
      'F3#..',
      '2.#..',
      '1#2..',
      '112..',
      '1.2#.',
      '1#2..',
      '112..',
      '2.2#.',
      'F#...',
      'FF21#',
    ],
    open: true,
    partial: true,
    goal: {
      reveal: [
        [3, 1],
        [3, 3],
      ],
      flag: [],
    },
    hints: [
      {
        numbers: [[1, 0]],
        marks: [],
        text: () => m.minesweeper_pattern_chain_hint_1(),
      },
      {
        numbers: [[1, 0]],
        marks: [group(1, [1, 1, 2, 1])],
        text: () => m.minesweeper_pattern_chain_hint_2(),
      },
      {
        numbers: [[2, 7]],
        marks: [group(1, [1, 8, 3, 1])],
        text: () => m.minesweeper_pattern_chain_hint_3(),
      },
      {
        numbers: [[2, 7]],
        marks: [group(1, [1, 7, 1, 1], [3, 7, 1, 1])],
        text: () => m.minesweeper_pattern_chain_hint_4(),
      },
      {
        numbers: [[2, 5]],
        marks: [group(1, [1, 5, 1, 1], [3, 5, 1, 1])],
        text: () => m.minesweeper_pattern_chain_hint_5(),
      },
      {
        numbers: [[2, 3]],
        marks: [group(1, [1, 4, 1, 1], [3, 4, 1, 1])],
        text: () => m.minesweeper_pattern_chain_hint_6(),
      },
      {
        numbers: [[2, 3]],
        marks: [group(1, [1, 2, 1, 1], [3, 2, 1, 1])],
        text: () => m.minesweeper_pattern_chain_hint_7(),
      },
      {
        numbers: [[2, 2]],
        marks: [
          group(1, [1, 1, 2, 1]),
          group(1, [1, 2, 1, 1], [3, 2, 1, 1]),
          safe([3, 1, 1, 1], [3, 3, 1, 1]),
        ],
        text: () => m.minesweeper_pattern_chain_hint_8(),
      },
    ],
  },
  {
    id: 'mine_counting',
    section: SECTION.endgame,
    title: () => m.minesweeper_pattern_mine_counting_title(),
    body: () => m.minesweeper_pattern_mine_counting_body(),
    rows: [
      '..F..',
      '1334#',
      '#3F#.',
      '.4F31',
      '2F210',
      '#2100',
      '.1000',
      '12121',
      '#3F3F',
      '..#..',
    ],
    partial: true,
    goal: {
      reveal: [
        [0, 9],
        [1, 9],
      ],
      flag: [],
    },
    hints: [
      {
        numbers: [[3, 1]],
        marks: [group(2, [3, 0, 2, 1], [4, 1, 1, 1], [3, 2, 2, 1])],
        text: () => m.minesweeper_pattern_mine_counting_hint_1(),
      },
      {
        numbers: [[1, 1]],
        marks: [group(1, [0, 0, 2, 1], [0, 2, 1, 1])],
        text: () => m.minesweeper_pattern_mine_counting_hint_2(),
      },
      {
        numbers: [[0, 4]],
        marks: [group(1, [0, 3, 1, 1], [0, 5, 1, 1])],
        text: () => m.minesweeper_pattern_mine_counting_hint_3(),
      },
      {
        numbers: [[1, 7]],
        marks: [group(1, [0, 6, 1, 1], [0, 8, 1, 1])],
        text: () => m.minesweeper_pattern_mine_counting_hint_4(),
      },
      {
        numbers: [[3, 8]],
        marks: [group(1, [2, 9, 3, 1])],
        text: () => m.minesweeper_pattern_mine_counting_hint_5(),
      },
      {
        numbers: [],
        marks: [safe([0, 9, 2, 1])],
        text: () => m.minesweeper_pattern_mine_counting_hint_6(),
      },
    ],
  },
  {
    id: 'combinations',
    section: SECTION.endgame,
    title: () => m.minesweeper_pattern_combinations_title(),
    body: () => m.minesweeper_pattern_combinations_body(),
    rows: ['F4F3.1', 'F.#.#2', 'F#.22F', 'F32.21', '2..#31', '1#3FF1'],
    partial: true,
    goal: {
      reveal: [[1, 1]],
      flag: [],
    },
    hints: [
      {
        numbers: [[1, 0]],
        marks: [group(undefined, [1, 1, 1, 1])],
        text: () => m.minesweeper_pattern_combinations_hint_1(),
      },
      {
        numbers: [[1, 0]],
        marks: [group(undefined, [1, 1, 1, 1])],
        text: () => m.minesweeper_pattern_combinations_hint_2(),
      },
      {
        numbers: [[1, 0]],
        marks: [group(undefined, [1, 1, 1, 1])],
        text: () => m.minesweeper_pattern_combinations_hint_3(),
      },
      {
        numbers: [[1, 0]],
        marks: [safe([1, 1, 1, 1])],
        text: () => m.minesweeper_pattern_combinations_hint_4(),
      },
    ],
  },
];
