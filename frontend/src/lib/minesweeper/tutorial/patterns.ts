import { m } from '$lib/paraglide/messages';
import { LESSONS, group, mine, safe, type Lesson } from './lessons';

/**
 * THE PATTERN CATALOGUE, the tutorial's ANNEX (owner, 2026-11-26: *"reprend leurs explications pour tous
 * les patterns dans un tutoriel annexe"*). Every named pattern of the reference catalogue
 * (minesweeper.online, "Patterns"), one playable board each, listed by family: the basics, the 1-2
 * combinations, the reduction of a number by its flags, the holes, the triangles, the complex patterns and
 * the endgame.
 *
 * **The boards are OURS and the words are ours**: the reference draws its patterns as pictures, and states
 * what each concludes. Each board here was found by an exhaustive search (a board where the stated
 * numbers are present and the conclusion is true) and is PROVED by `lessons.test.ts`, like every lesson of
 * the tutorial: what it asks to open is safe, what it asks to flag is a mine, and every highlight is true
 * in every arrangement the numbers and the mines counter allow. Where the reference gives a name but not a
 * shape (the holes, the T pattern, the dependency chain), the board is our reading of its statement.
 *
 * A pattern the tutorial already teaches (B1, B2, 1-1, 1-2-1, 1-2-2-1, the corners, the counter) is the SAME
 * lesson, listed here under its family.
 */

const SECTION = {
  basics: () => m.minesweeper_patterns_section_basics(),
  pairs: () => m.minesweeper_patterns_section_pairs(),
  reduction: () => m.minesweeper_patterns_section_reduction(),
  holes: () => m.minesweeper_patterns_section_holes(),
  triangles: () => m.minesweeper_patterns_section_triangles(),
  complex: () => m.minesweeper_patterns_section_complex(),
  endgame: () => m.minesweeper_patterns_section_endgame(),
};

/** A lesson of the tutorial, listed in the catalogue under its family. */
function reuse(id: string, section: () => string): Lesson {
  const lesson = LESSONS.find((l) => l.id === id);
  if (!lesson) throw new Error(`pattern catalogue: no tutorial lesson '${id}'`);
  return { ...lesson, section };
}

export const PATTERNS: readonly Lesson[] = [
  reuse('autoflag', SECTION.basics),
  reuse('chord', SECTION.basics),
  reuse('one_one', SECTION.basics),
  {
    id: 'one_one_plus',
    section: SECTION.basics,
    open: true,
    title: () => m.minesweeper_pattern_one_one_plus_title(),
    body: () => m.minesweeper_pattern_one_one_plus_body(),
    rows: ['..1', '1#1', '..2', '##1'],
    goal: {
      reveal: [
        [0, 0],
        [1, 0],
        [0, 2],
        [1, 2],
      ],
      flag: [
        [1, 1],
        [1, 3],
      ],
    },
    hints: [
      {
        numbers: [[2, 0]],
        marks: [group(1, [1, 0, 1, 2])],
        text: () => m.minesweeper_pattern_one_one_plus_hint_1(),
      },
      {
        numbers: [[0, 1]],
        marks: [group(1, [0, 0, 2, 1], [1, 1, 1, 1], [0, 2, 2, 1])],
        text: () => m.minesweeper_pattern_one_one_plus_hint_2(),
      },
      {
        numbers: [
          [2, 0],
          [0, 1],
        ],
        marks: [safe([0, 0, 1, 1], [0, 2, 2, 1])],
        text: () => m.minesweeper_pattern_one_one_plus_hint_3(),
      },
    ],
  },
  {
    id: 'one_two',
    section: SECTION.basics,
    open: true,
    title: () => m.minesweeper_pattern_one_two_title(),
    body: () => m.minesweeper_pattern_one_two_body(),
    rows: ['#.1', '.#2', '.#2', '..1'],
    goal: {
      reveal: [
        [1, 0],
        [1, 3],
      ],
      flag: [
        [1, 1],
        [1, 2],
      ],
    },
    hints: [
      {
        numbers: [[2, 0]],
        marks: [group(1, [1, 0, 1, 2])],
        text: () => m.minesweeper_pattern_one_two_hint_1(),
      },
      {
        numbers: [[2, 1]],
        marks: [group(2, [1, 0, 1, 3])],
        text: () => m.minesweeper_pattern_one_two_hint_2(),
      },
      {
        numbers: [
          [2, 0],
          [2, 1],
        ],
        marks: [mine([1, 2, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_hint_3(),
      },
    ],
  },
  {
    id: 'one_two_plus',
    section: SECTION.basics,
    open: true,
    title: () => m.minesweeper_pattern_one_two_plus_title(),
    body: () => m.minesweeper_pattern_one_two_plus_body(),
    rows: ['1.#', '1##', '2.4', '1##'],
    goal: {
      reveal: [
        [1, 0],
        [1, 2],
      ],
      flag: [
        [1, 1],
        [2, 1],
        [1, 3],
        [2, 3],
      ],
    },
    hints: [
      {
        numbers: [[0, 3]],
        marks: [group(1, [1, 2, 1, 2])],
        text: () => m.minesweeper_pattern_one_two_plus_hint_1(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(4, [1, 1, 2, 1], [1, 2, 1, 1], [1, 3, 2, 1])],
        text: () => m.minesweeper_pattern_one_two_plus_hint_2(),
      },
      {
        numbers: [
          [0, 3],
          [2, 2],
        ],
        marks: [mine([1, 1, 2, 1], [2, 3, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_plus_hint_3(),
      },
    ],
  },
  {
    id: 'one_two_c',
    section: SECTION.basics,
    open: true,
    title: () => m.minesweeper_pattern_one_two_c_title(),
    body: () => m.minesweeper_pattern_one_two_c_body(),
    rows: ['#.1', '.#1', '..2', '.#1'],
    goal: {
      reveal: [
        [1, 0],
        [1, 2],
      ],
      flag: [
        [1, 1],
        [1, 3],
      ],
    },
    hints: [
      {
        numbers: [[2, 1]],
        marks: [group(1, [1, 0, 1, 3])],
        text: () => m.minesweeper_pattern_one_two_c_hint_1(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(2, [1, 1, 1, 3])],
        text: () => m.minesweeper_pattern_one_two_c_hint_2(),
      },
      {
        numbers: [
          [2, 1],
          [2, 2],
        ],
        marks: [mine([1, 3, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_c_hint_3(),
      },
    ],
  },
  {
    id: 'one_two_c_plus',
    section: SECTION.basics,
    open: true,
    title: () => m.minesweeper_pattern_one_two_c_plus_title(),
    body: () => m.minesweeper_pattern_one_two_c_plus_body(),
    rows: ['1##', '2.4', '1##', '1.#'],
    goal: {
      reveal: [
        [1, 1],
        [1, 3],
      ],
      flag: [
        [1, 0],
        [2, 0],
        [1, 2],
        [2, 2],
      ],
    },
    hints: [
      {
        numbers: [[0, 2]],
        marks: [group(1, [1, 1, 1, 3])],
        text: () => m.minesweeper_pattern_one_two_c_plus_hint_1(),
      },
      {
        numbers: [[2, 1]],
        marks: [group(4, [1, 0, 2, 1], [1, 1, 1, 1], [1, 2, 2, 1])],
        text: () => m.minesweeper_pattern_one_two_c_plus_hint_2(),
      },
      {
        numbers: [
          [0, 2],
          [2, 1],
        ],
        marks: [mine([1, 0, 2, 1], [2, 2, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_c_plus_hint_3(),
      },
    ],
  },
  reuse('one_two_one', SECTION.pairs),
  reuse('one_two_two_one', SECTION.pairs),
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
    rows: ['FFF', '343', '.#.'],
    goal: {
      reveal: [
        [0, 2],
        [2, 2],
      ],
      flag: [[1, 2]],
    },
    hints: [
      {
        numbers: [
          [0, 1],
          [1, 1],
        ],
        marks: [mine([0, 0, 3, 1])],
        reduced: [
          { cell: [0, 1], value: 1 },
          { cell: [1, 1], value: 1 },
        ],
        text: () => m.minesweeper_pattern_reduced_one_one_hint_1(),
      },
      {
        numbers: [[0, 1]],
        marks: [group(1, [0, 2, 2, 1])],
        text: () => m.minesweeper_pattern_reduced_one_one_hint_2(),
      },
      {
        numbers: [[1, 1]],
        marks: [group(1, [0, 2, 3, 1])],
        text: () => m.minesweeper_pattern_reduced_one_one_hint_3(),
      },
      {
        numbers: [
          [0, 1],
          [1, 1],
        ],
        marks: [safe([2, 2, 1, 1])],
        text: () => m.minesweeper_pattern_reduced_one_one_hint_4(),
      },
    ],
  },
  {
    id: 'reduced_one_two',
    section: SECTION.reduction,
    title: () => m.minesweeper_pattern_reduced_one_two_title(),
    body: () => m.minesweeper_pattern_reduced_one_two_body(),
    rows: ['1F1', '233', '.##'],
    goal: {
      reveal: [[0, 2]],
      flag: [
        [1, 2],
        [2, 2],
      ],
    },
    hints: [
      {
        numbers: [
          [0, 1],
          [1, 1],
        ],
        marks: [mine([1, 0, 1, 1])],
        reduced: [
          { cell: [0, 1], value: 1 },
          { cell: [1, 1], value: 2 },
        ],
        text: () => m.minesweeper_pattern_reduced_one_two_hint_1(),
      },
      {
        numbers: [[0, 1]],
        marks: [group(1, [0, 2, 2, 1])],
        text: () => m.minesweeper_pattern_reduced_one_two_hint_2(),
      },
      {
        numbers: [[1, 1]],
        marks: [group(2, [0, 2, 3, 1])],
        text: () => m.minesweeper_pattern_reduced_one_two_hint_3(),
      },
      {
        numbers: [
          [0, 1],
          [1, 1],
        ],
        marks: [mine([2, 2, 1, 1])],
        text: () => m.minesweeper_pattern_reduced_one_two_hint_4(),
      },
    ],
  },
  {
    id: 'reduced_one_two_one',
    section: SECTION.reduction,
    title: () => m.minesweeper_pattern_reduced_one_two_one_title(),
    body: () => m.minesweeper_pattern_reduced_one_two_one_body(),
    rows: ['1F1', '232', '#.#'],
    goal: {
      reveal: [[1, 2]],
      flag: [
        [0, 2],
        [2, 2],
      ],
    },
    hints: [
      {
        numbers: [
          [0, 1],
          [1, 1],
          [2, 1],
        ],
        marks: [mine([1, 0, 1, 1])],
        reduced: [
          { cell: [0, 1], value: 1 },
          { cell: [1, 1], value: 2 },
          { cell: [2, 1], value: 1 },
        ],
        text: () => m.minesweeper_pattern_reduced_one_two_one_hint_1(),
      },
      {
        numbers: [[1, 1]],
        marks: [group(2, [0, 2, 3, 1])],
        text: () => m.minesweeper_pattern_reduced_one_two_one_hint_2(),
      },
      {
        numbers: [
          [0, 1],
          [2, 1],
        ],
        marks: [group(1, [0, 2, 2, 1]), group(1, [1, 2, 2, 1])],
        text: () => m.minesweeper_pattern_reduced_one_two_one_hint_3(),
      },
      {
        numbers: [[1, 1]],
        marks: [mine([0, 2, 1, 1], [2, 2, 1, 1]), safe([1, 2, 1, 1])],
        text: () => m.minesweeper_pattern_reduced_one_two_one_hint_4(),
      },
    ],
  },
  {
    id: 'hole_1',
    section: SECTION.holes,
    open: true,
    title: () => m.minesweeper_pattern_hole_1_title(),
    body: () => m.minesweeper_pattern_hole_1_body(),
    rows: ['1##', '1..', '1..', '1#.'],
    goal: {
      reveal: [
        [1, 1],
        [1, 2],
      ],
      flag: [
        [1, 0],
        [1, 3],
      ],
    },
    hints: [
      {
        numbers: [[0, 0]],
        marks: [group(1, [1, 0, 1, 2])],
        text: () => m.minesweeper_pattern_hole_1_hint_1(),
      },
      {
        numbers: [[0, 1]],
        marks: [group(1, [1, 0, 1, 3])],
        text: () => m.minesweeper_pattern_hole_1_hint_2(),
      },
      {
        numbers: [
          [0, 0],
          [0, 1],
        ],
        marks: [safe([1, 2, 1, 1])],
        text: () => m.minesweeper_pattern_hole_1_hint_3(),
      },
    ],
  },
  {
    id: 'hole_2',
    section: SECTION.holes,
    open: true,
    title: () => m.minesweeper_pattern_hole_2_title(),
    body: () => m.minesweeper_pattern_hole_2_body(),
    rows: ['1.#', '1#.', '2..', '1#.'],
    goal: {
      reveal: [
        [1, 0],
        [1, 2],
      ],
      flag: [
        [1, 1],
        [1, 3],
      ],
    },
    hints: [
      {
        numbers: [[0, 0]],
        marks: [group(1, [1, 0, 1, 2])],
        text: () => m.minesweeper_pattern_hole_2_hint_1(),
      },
      {
        numbers: [[0, 1]],
        marks: [group(1, [1, 0, 1, 3])],
        text: () => m.minesweeper_pattern_hole_2_hint_2(),
      },
      {
        numbers: [
          [0, 0],
          [0, 1],
        ],
        marks: [safe([1, 2, 1, 1])],
        text: () => m.minesweeper_pattern_hole_2_hint_3(),
      },
    ],
  },
  {
    id: 'hole_3',
    section: SECTION.holes,
    open: true,
    title: () => m.minesweeper_pattern_hole_3_title(),
    body: () => m.minesweeper_pattern_hole_3_body(),
    rows: ['##1', '..1', '..1', '.#1'],
    goal: {
      reveal: [
        [1, 1],
        [1, 2],
      ],
      flag: [
        [1, 0],
        [1, 3],
      ],
    },
    hints: [
      {
        numbers: [[2, 0]],
        marks: [group(1, [1, 0, 1, 2])],
        text: () => m.minesweeper_pattern_hole_3_hint_1(),
      },
      {
        numbers: [[2, 1]],
        marks: [group(1, [1, 0, 1, 3])],
        text: () => m.minesweeper_pattern_hole_3_hint_2(),
      },
      {
        numbers: [
          [2, 0],
          [2, 1],
        ],
        marks: [safe([1, 2, 1, 1])],
        text: () => m.minesweeper_pattern_hole_3_hint_3(),
      },
    ],
  },
  {
    id: 'triangle_1',
    section: SECTION.triangles,
    open: true,
    title: () => m.minesweeper_pattern_triangle_1_title(),
    body: () => m.minesweeper_pattern_triangle_1_body(),
    rows: ['1##', '1..', '1.1', '1#.'],
    goal: {
      reveal: [
        [1, 1],
        [2, 1],
        [1, 2],
        [2, 3],
      ],
      flag: [
        [1, 0],
        [1, 3],
      ],
    },
    hints: [
      {
        numbers: [[0, 2]],
        marks: [group(1, [1, 1, 1, 3])],
        text: () => m.minesweeper_pattern_triangle_1_hint_1(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(1, [1, 1, 2, 1], [1, 2, 1, 1], [1, 3, 2, 1])],
        text: () => m.minesweeper_pattern_triangle_1_hint_2(),
      },
      {
        numbers: [
          [0, 2],
          [2, 2],
        ],
        marks: [safe([2, 1, 1, 1], [2, 3, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_1_hint_3(),
      },
    ],
  },
  {
    id: 'triangle_2',
    section: SECTION.triangles,
    open: true,
    title: () => m.minesweeper_pattern_triangle_2_title(),
    body: () => m.minesweeper_pattern_triangle_2_body(),
    rows: ['1.#', '1#.', '2..', '1#.'],
    goal: {
      reveal: [
        [1, 0],
        [1, 2],
      ],
      flag: [
        [1, 1],
        [1, 3],
      ],
    },
    hints: [
      {
        numbers: [[0, 1]],
        marks: [group(1, [1, 0, 1, 3])],
        text: () => m.minesweeper_pattern_triangle_2_hint_1(),
      },
      {
        numbers: [[0, 2]],
        marks: [group(2, [1, 1, 1, 3])],
        text: () => m.minesweeper_pattern_triangle_2_hint_2(),
      },
      {
        numbers: [
          [0, 1],
          [0, 2],
        ],
        marks: [mine([1, 3, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_2_hint_3(),
      },
    ],
  },
  {
    id: 'triangle_3',
    section: SECTION.triangles,
    open: true,
    title: () => m.minesweeper_pattern_triangle_3_title(),
    body: () => m.minesweeper_pattern_triangle_3_body(),
    rows: ['#.10', '.#10', '2.31', '.##1'],
    goal: {
      reveal: [
        [1, 0],
        [0, 1],
        [1, 2],
        [0, 3],
      ],
      flag: [
        [1, 1],
        [1, 3],
        [2, 3],
      ],
    },
    hints: [
      {
        numbers: [[0, 2]],
        marks: [group(2, [0, 1, 2, 1], [1, 2, 1, 1], [0, 3, 2, 1])],
        text: () => m.minesweeper_pattern_triangle_3_hint_1(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(3, [1, 1, 1, 2], [1, 3, 2, 1])],
        text: () => m.minesweeper_pattern_triangle_3_hint_2(),
      },
      {
        numbers: [
          [0, 2],
          [2, 2],
        ],
        marks: [mine([2, 3, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_3_hint_3(),
      },
    ],
  },
  {
    id: 'triangle_4',
    section: SECTION.triangles,
    open: true,
    title: () => m.minesweeper_pattern_triangle_4_title(),
    body: () => m.minesweeper_pattern_triangle_4_body(),
    rows: ['..#', '2#4', '2##', '1.#'],
    goal: {
      reveal: [[0, 0]],
      flag: [
        [2, 0],
        [1, 1],
        [2, 2],
      ],
    },
    hints: [
      {
        numbers: [[0, 1]],
        marks: [group(2, [0, 0, 2, 1], [1, 1, 1, 2])],
        text: () => m.minesweeper_pattern_triangle_4_hint_1(),
      },
      {
        numbers: [[2, 1]],
        marks: [group(4, [1, 0, 2, 1], [1, 1, 1, 1], [1, 2, 2, 1])],
        text: () => m.minesweeper_pattern_triangle_4_hint_2(),
      },
      {
        numbers: [
          [0, 1],
          [2, 1],
        ],
        marks: [mine([2, 0, 1, 1], [2, 2, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_4_hint_3(),
      },
    ],
  },
  {
    id: 'triangle_5',
    section: SECTION.triangles,
    open: true,
    title: () => m.minesweeper_pattern_triangle_5_title(),
    body: () => m.minesweeper_pattern_triangle_5_body(),
    rows: ['##1', '..2', '.#1', '..1'],
    goal: {
      reveal: [
        [1, 1],
        [1, 3],
      ],
      flag: [
        [1, 0],
        [1, 2],
      ],
    },
    hints: [
      {
        numbers: [[2, 2]],
        marks: [group(1, [1, 1, 1, 3])],
        text: () => m.minesweeper_pattern_triangle_5_hint_1(),
      },
      {
        numbers: [[2, 1]],
        marks: [group(2, [1, 0, 1, 3])],
        text: () => m.minesweeper_pattern_triangle_5_hint_2(),
      },
      {
        numbers: [
          [2, 2],
          [2, 1],
        ],
        marks: [mine([1, 0, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_5_hint_3(),
      },
    ],
  },
  reuse('angle_one_three_one', SECTION.complex),
  reuse('angle_two_two_two', SECTION.complex),
  {
    id: 'gt_two_lt',
    section: SECTION.complex,
    open: true,
    title: () => m.minesweeper_pattern_gt_two_lt_title(),
    body: () => m.minesweeper_pattern_gt_two_lt_body(),
    rows: ['112.1', '.#.#.', '....#'],
    goal: {
      reveal: [
        [0, 1],
        [2, 1],
        [4, 1],
      ],
      flag: [[1, 1]],
    },
    hints: [
      {
        numbers: [[1, 0]],
        marks: [group(1, [0, 1, 3, 1])],
        text: () => m.minesweeper_pattern_gt_two_lt_hint_1(),
      },
      {
        numbers: [[4, 0]],
        marks: [group(1, [3, 0, 1, 1], [3, 1, 2, 1])],
        text: () => m.minesweeper_pattern_gt_two_lt_hint_2(),
      },
      {
        numbers: [[2, 0]],
        marks: [group(2, [3, 0, 1, 1], [1, 1, 3, 1])],
        text: () => m.minesweeper_pattern_gt_two_lt_hint_3(),
      },
      {
        numbers: [[2, 0]],
        marks: [group(1, [1, 1, 2, 1]), group(1, [3, 0, 1, 2]), safe([0, 1, 1, 1], [4, 1, 1, 1])],
        text: () => m.minesweeper_pattern_gt_two_lt_hint_4(),
      },
    ],
  },
  {
    id: 't_pattern',
    section: SECTION.complex,
    open: true,
    title: () => m.minesweeper_pattern_t_pattern_title(),
    body: () => m.minesweeper_pattern_t_pattern_body(),
    rows: ['0001##', '0002..', '0001#.', '1213..', '#.#.#.'],
    goal: {
      reveal: [
        [4, 1],
        [4, 3],
        [1, 4],
        [3, 4],
      ],
      flag: [
        [4, 0],
        [4, 2],
        [0, 4],
        [2, 4],
        [4, 4],
      ],
    },
    hints: [
      {
        numbers: [[3, 3]],
        marks: [group(3, [4, 2, 1, 2], [2, 4, 3, 1])],
        text: () => m.minesweeper_pattern_t_pattern_hint_1(),
      },
      {
        numbers: [
          [3, 2],
          [2, 3],
        ],
        marks: [group(1, [4, 1, 1, 3]), group(1, [1, 4, 3, 1])],
        text: () => m.minesweeper_pattern_t_pattern_hint_2(),
      },
      {
        numbers: [[3, 3]],
        marks: [mine([4, 4, 1, 1]), safe([4, 1, 1, 1], [1, 4, 1, 1])],
        text: () => m.minesweeper_pattern_t_pattern_hint_3(),
      },
      {
        numbers: [],
        marks: [
          mine([4, 0, 1, 1], [4, 2, 1, 1], [0, 4, 1, 1], [2, 4, 1, 1], [4, 4, 1, 1]),
          safe([4, 1, 1, 1], [4, 3, 1, 1], [1, 4, 1, 1], [3, 4, 1, 1]),
        ],
        text: () => m.minesweeper_pattern_t_pattern_hint_4(),
      },
    ],
  },
  {
    id: 'chain',
    section: SECTION.complex,
    title: () => m.minesweeper_pattern_chain_title(),
    body: () => m.minesweeper_pattern_chain_body(),
    rows: ['11212121', '.#.#.#.#'],
    goal: {
      reveal: [
        [0, 1],
        [2, 1],
        [4, 1],
        [6, 1],
      ],
      flag: [
        [1, 1],
        [3, 1],
        [5, 1],
        [7, 1],
      ],
    },
    hints: [
      {
        numbers: [
          [0, 0],
          [1, 0],
        ],
        marks: [group(1, [0, 1, 2, 1]), safe([2, 1, 1, 1])],
        text: () => m.minesweeper_pattern_chain_hint_1(),
      },
      {
        numbers: [[2, 0]],
        marks: [mine([1, 1, 1, 1], [3, 1, 1, 1])],
        text: () => m.minesweeper_pattern_chain_hint_2(),
      },
      {
        numbers: [
          [6, 0],
          [7, 0],
        ],
        marks: [group(1, [6, 1, 2, 1]), mine([5, 1, 1, 1])],
        text: () => m.minesweeper_pattern_chain_hint_3(),
      },
      {
        numbers: [],
        marks: [
          mine([1, 1, 1, 1], [3, 1, 1, 1], [5, 1, 1, 1], [7, 1, 1, 1]),
          safe([0, 1, 1, 1], [2, 1, 1, 1], [4, 1, 1, 1], [6, 1, 1, 1]),
        ],
        text: () => m.minesweeper_pattern_chain_hint_4(),
      },
    ],
  },
  reuse('counter', SECTION.endgame),
  {
    id: 'combinations',
    section: SECTION.endgame,
    title: () => m.minesweeper_pattern_combinations_title(),
    body: () => m.minesweeper_pattern_combinations_body(),
    rows: ['112..', '.#.#.'],
    goal: {
      reveal: [
        [4, 0],
        [0, 1],
        [2, 1],
        [4, 1],
      ],
      flag: [[1, 1]],
    },
    hints: [
      {
        numbers: [[0, 0]],
        marks: [group(1, [0, 1, 2, 1])],
        text: () => m.minesweeper_pattern_combinations_hint_1(),
      },
      {
        numbers: [[2, 0]],
        marks: [group(2, [3, 0, 1, 1], [1, 1, 3, 1])],
        text: () => m.minesweeper_pattern_combinations_hint_2(),
      },
      {
        numbers: [
          [0, 0],
          [2, 0],
        ],
        marks: [group(undefined, [0, 1, 1, 1])],
        text: () => m.minesweeper_pattern_combinations_hint_3(),
      },
      {
        numbers: [],
        marks: [mine([1, 1, 1, 1]), safe([4, 0, 1, 2], [0, 1, 1, 1], [2, 1, 1, 1])],
        text: () => m.minesweeper_pattern_combinations_hint_4(),
      },
    ],
  },
];
