import { m } from '$lib/paraglide/messages';
import { group, mine, safe, type Lesson } from './lessons';

/**
 * THE PATTERN CATALOGUE, the tutorial's ANNEX (owner, 2026-11-26: *"reprend leurs explications pour tous
 * les patterns dans un tutoriel annexe"*, then *"utilise ceux de minesweeper.online tels quels"*). Every
 * pattern of the reference catalogue (minesweeper.online, "Patterns"), in the reference's own order and
 * families, one playable board each: the basic patterns, the reduction of a number by its flags, the holes, the
 * triangles, the high complexity patterns and the last turns.
 *
 * **A picture holds its pattern and nothing else** (owner, 2026-11-27: *"il faut que ces grilles ne soient
 * resolvables QUE en comprenant le pattern"*). The numbers are the pattern's own; every other open cell is a `?`
 * (open, number hidden), and where the board would go on it goes on into FOG (`~`, `X`: hidden, dotted, never
 * playable) instead of ending on a wall - a wall is information, and a pattern drawn against one can be solved by
 * a smaller one (a 1-2-1 against an edge holds a 1-2). Where a pattern NEEDS a bound (the first 1 of a 1-1 sees
 * two cells), the bound is drawn with `?` cells. The shapes, the steps and the families are the reference's
 * (minesweeper.online, "Patterns", credited on the wiki page); the sentences are ours.
 *
 * `lessons.test.ts` holds every picture to it: the goal IS everything the numbers force, every number shown is
 * read by a step of the explanation and is NEEDED (without it the goal is no longer forced), no pattern number
 * sits on the picture's border, and surrounding the picture with fog changes nothing.
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
    rows: ['0?#', '03#', '0?#'],
    open: true,
    goal: {
      reveal: [],
      flag: [
        [2, 0],
        [2, 1],
        [2, 2],
      ],
    },
    hints: [
      {
        numbers: [[1, 1]],
        marks: [group(3, [2, 0, 1, 3])],
        text: () => m.minesweeper_pattern_basic_mines_hint_1(),
      },
      {
        numbers: [[1, 1]],
        marks: [mine([2, 0, 1, 3])],
        text: () => m.minesweeper_pattern_basic_mines_hint_2(),
      },
    ],
  },
  {
    id: 'basic_flags',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_basic_flags_title(),
    body: () => m.minesweeper_pattern_basic_flags_body(),
    rows: ['02F', '?2F', '...', 'X~~'],
    open: true,
    goal: {
      reveal: [
        [0, 2],
        [1, 2],
        [2, 2],
      ],
      flag: [],
    },
    hints: [
      {
        numbers: [[1, 1]],
        marks: [mine([2, 0, 1, 2])],
        text: () => m.minesweeper_pattern_basic_flags_hint_1(),
      },
      {
        numbers: [[1, 1]],
        marks: [safe([0, 2, 3, 1])],
        text: () => m.minesweeper_pattern_basic_flags_hint_2(),
      },
    ],
  },
  {
    id: 'one_one',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_one_one_title(),
    body: () => m.minesweeper_pattern_one_one_body(),
    rows: ['~~~~X', '?#..~', '?11??', '00000'],
    open: true,
    goal: {
      reveal: [[3, 1]],
      flag: [],
    },
    hints: [
      {
        numbers: [[1, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_one_one_hint_1(),
      },
      {
        numbers: [[1, 2]],
        marks: [group(1, [1, 1, 2, 1])],
        text: () => m.minesweeper_pattern_one_one_hint_2(),
      },
      {
        numbers: [[2, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_one_one_hint_3(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(1, [1, 1, 2, 1]), safe([3, 1, 1, 1])],
        text: () => m.minesweeper_pattern_one_one_hint_4(),
      },
    ],
  },
  {
    id: 'one_one_plus',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_one_one_plus_title(),
    body: () => m.minesweeper_pattern_one_one_plus_body(),
    rows: ['?#...', '?11.X', '00?.~'],
    open: true,
    goal: {
      reveal: [
        [3, 0],
        [3, 1],
        [3, 2],
      ],
      flag: [],
    },
    hints: [
      {
        numbers: [[1, 1]],
        marks: [],
        text: () => m.minesweeper_pattern_one_one_plus_hint_1(),
      },
      {
        numbers: [[1, 1]],
        marks: [group(1, [1, 0, 2, 1])],
        text: () => m.minesweeper_pattern_one_one_plus_hint_2(),
      },
      {
        numbers: [[2, 1]],
        marks: [],
        text: () => m.minesweeper_pattern_one_one_plus_hint_3(),
      },
      {
        numbers: [[2, 1]],
        marks: [group(1, [1, 0, 2, 1]), safe([3, 0, 1, 3])],
        text: () => m.minesweeper_pattern_one_one_plus_hint_4(),
      },
    ],
  },
  {
    id: 'one_two',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_one_two_title(),
    body: () => m.minesweeper_pattern_one_two_body(),
    rows: ['?#.#~', '?12??', '00000'],
    open: true,
    goal: {
      reveal: [],
      flag: [[3, 0]],
    },
    hints: [
      {
        numbers: [[1, 1]],
        marks: [],
        text: () => m.minesweeper_pattern_one_two_hint_1(),
      },
      {
        numbers: [[1, 1]],
        marks: [group(1, [1, 0, 2, 1])],
        text: () => m.minesweeper_pattern_one_two_hint_2(),
      },
      {
        numbers: [[2, 1]],
        marks: [],
        text: () => m.minesweeper_pattern_one_two_hint_3(),
      },
      {
        numbers: [[2, 1]],
        marks: [group(1, [1, 0, 2, 1]), mine([3, 0, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_hint_4(),
      },
    ],
  },
  {
    id: 'one_two_plus',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_one_two_plus_title(),
    body: () => m.minesweeper_pattern_one_two_plus_body(),
    rows: ['?#.#', '?14#', '00?#'],
    open: true,
    goal: {
      reveal: [],
      flag: [
        [3, 0],
        [3, 1],
        [3, 2],
      ],
    },
    hints: [
      {
        numbers: [[1, 1]],
        marks: [],
        text: () => m.minesweeper_pattern_one_two_plus_hint_1(),
      },
      {
        numbers: [[1, 1]],
        marks: [group(1, [1, 0, 2, 1])],
        text: () => m.minesweeper_pattern_one_two_plus_hint_2(),
      },
      {
        numbers: [[2, 1]],
        marks: [],
        text: () => m.minesweeper_pattern_one_two_plus_hint_3(),
      },
      {
        numbers: [[2, 1]],
        marks: [group(1, [1, 0, 2, 1]), mine([3, 0, 1, 3])],
        text: () => m.minesweeper_pattern_one_two_plus_hint_4(),
      },
    ],
  },
  {
    id: 'one_two_c',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_one_two_c_title(),
    body: () => m.minesweeper_pattern_one_two_c_body(),
    rows: ['X~~~~', '..##~', '?12??', '00000'],
    open: true,
    goal: {
      reveal: [[0, 1]],
      flag: [[3, 1]],
    },
    hints: [
      {
        numbers: [[1, 2]],
        marks: [group(undefined, [1, 1, 2, 1])],
        text: () => m.minesweeper_pattern_one_two_c_hint_1(),
      },
      {
        numbers: [[1, 2]],
        marks: [group(undefined, [1, 1, 2, 1])],
        text: () => m.minesweeper_pattern_one_two_c_hint_2(),
      },
      {
        numbers: [[2, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_one_two_c_hint_3(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(1, [1, 1, 2, 1]), mine([3, 1, 1, 1]), safe([0, 1, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_c_hint_4(),
      },
    ],
  },
  {
    id: 'one_two_c_plus',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_one_two_c_plus_title(),
    body: () => m.minesweeper_pattern_one_two_c_plus_body(),
    rows: ['X~~~', '..##', '?14#', '00?#'],
    open: true,
    goal: {
      reveal: [[0, 1]],
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
        marks: [group(1, [1, 1, 2, 1]), mine([3, 1, 1, 3]), safe([0, 1, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_c_plus_hint_4(),
      },
    ],
  },
  {
    id: 'one_two_one',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_one_two_one_title(),
    body: () => m.minesweeper_pattern_one_two_one_body(),
    rows: ['~#.#~', '?121?', '00000'],
    open: true,
    goal: {
      reveal: [[2, 0]],
      flag: [
        [1, 0],
        [3, 0],
      ],
    },
    hints: [
      {
        numbers: [
          [1, 1],
          [2, 1],
        ],
        marks: [group(undefined, [1, 0, 2, 1]), mine([3, 0, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_one_hint_1(),
      },
      {
        numbers: [
          [2, 1],
          [3, 1],
        ],
        marks: [group(undefined, [2, 0, 2, 1]), mine([1, 0, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_one_hint_2(),
      },
      {
        numbers: [[2, 1]],
        marks: [mine([1, 0, 1, 1], [3, 0, 1, 1]), safe([2, 0, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_one_hint_3(),
      },
    ],
  },
  {
    id: 'one_two_two_one',
    section: SECTION.basics,
    title: () => m.minesweeper_pattern_one_two_two_one_title(),
    body: () => m.minesweeper_pattern_one_two_two_one_body(),
    rows: ['~.##.~', '?1221?', '000000'],
    open: true,
    goal: {
      reveal: [
        [1, 0],
        [4, 0],
      ],
      flag: [
        [2, 0],
        [3, 0],
      ],
    },
    hints: [
      {
        numbers: [
          [1, 1],
          [2, 1],
        ],
        marks: [group(undefined, [1, 0, 2, 1]), mine([3, 0, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_two_one_hint_1(),
      },
      {
        numbers: [
          [3, 1],
          [4, 1],
        ],
        marks: [group(undefined, [3, 0, 2, 1]), mine([2, 0, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_two_one_hint_2(),
      },
      {
        numbers: [],
        marks: [mine([2, 0, 2, 1]), safe([1, 0, 1, 1], [4, 0, 1, 1])],
        text: () => m.minesweeper_pattern_one_two_two_one_hint_3(),
      },
    ],
  },
  {
    id: 'reduction_intro',
    section: SECTION.reduction,
    title: () => m.minesweeper_pattern_reduction_intro_title(),
    body: () => m.minesweeper_pattern_reduction_intro_body(),
    rows: ['011', '02F', '0?#'],
    open: true,
    goal: {
      reveal: [],
      flag: [[2, 2]],
    },
    hints: [
      {
        numbers: [[1, 1]],
        marks: [mine([2, 1, 1, 1])],
        reduced: [{ cell: [1, 1], value: 1 }],
        text: () => m.minesweeper_pattern_reduction_intro_hint_1(),
      },
      {
        numbers: [[1, 1]],
        marks: [mine([2, 2, 1, 1])],
        text: () => m.minesweeper_pattern_reduction_intro_hint_2(),
      },
    ],
  },
  {
    id: 'reduced_one_one',
    section: SECTION.reduction,
    title: () => m.minesweeper_pattern_reduced_one_one_title(),
    body: () => m.minesweeper_pattern_reduced_one_one_body(),
    rows: ['1?.X', 'F2.~', '34#~', 'FF?~'],
    open: true,
    goal: {
      reveal: [[2, 0]],
      flag: [],
    },
    hints: [
      {
        numbers: [[1, 1]],
        marks: [],
        reduced: [{ cell: [1, 1], value: 1 }],
        text: () => m.minesweeper_pattern_reduced_one_one_hint_1(),
      },
      {
        numbers: [[1, 2]],
        marks: [],
        reduced: [{ cell: [1, 2], value: 1 }],
        text: () => m.minesweeper_pattern_reduced_one_one_hint_2(),
      },
      {
        numbers: [
          [1, 1],
          [1, 2],
        ],
        marks: [group(1, [2, 1, 1, 2]), safe([2, 0, 1, 1])],
        reduced: [
          { cell: [1, 1], value: 1 },
          { cell: [1, 2], value: 1 },
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
    rows: ['1F11F', '??23?', '~..##', 'X~~~~'],
    open: true,
    goal: {
      reveal: [[1, 2]],
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
        marks: [group(undefined, [2, 2, 2, 1]), mine([4, 2, 1, 1]), safe([1, 2, 1, 1])],
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
    rows: ['~#.#~', '?232?', '01F10'],
    open: true,
    goal: {
      reveal: [[2, 0]],
      flag: [
        [1, 0],
        [3, 0],
      ],
    },
    hints: [
      {
        numbers: [
          [1, 1],
          [2, 1],
          [3, 1],
        ],
        marks: [mine([1, 0, 1, 1], [3, 0, 1, 1]), safe([2, 0, 1, 1])],
        reduced: [
          { cell: [1, 1], value: 1 },
          { cell: [2, 1], value: 2 },
          { cell: [3, 1], value: 1 },
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
    rows: ['~...X', '~#1.~', '??1??', '00000'],
    open: true,
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
        text: () => m.minesweeper_pattern_hole_1_hint_1(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(1, [1, 1, 1, 1], [3, 1, 1, 1])],
        text: () => m.minesweeper_pattern_hole_1_hint_2(),
      },
      {
        numbers: [[2, 1]],
        marks: [],
        text: () => m.minesweeper_pattern_hole_1_hint_3(),
      },
      {
        numbers: [[2, 1]],
        marks: [group(1, [1, 1, 1, 1], [3, 1, 1, 1]), safe([1, 0, 3, 1])],
        text: () => m.minesweeper_pattern_hole_1_hint_4(),
      },
    ],
  },
  {
    id: 'hole_2',
    section: SECTION.holes,
    title: () => m.minesweeper_pattern_hole_2_title(),
    body: () => m.minesweeper_pattern_hole_2_body(),
    rows: ['X...X', '~?1?~', '~#1.~', '?????'],
    open: true,
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
    rows: ['~X...', '~??1.', '~~?.#', '???1?', '00000'],
    open: true,
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
    rows: ['~...X', '~#1.~', '~.1??', '???00'],
    open: true,
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
        text: () => m.minesweeper_pattern_triangle_1_hint_1(),
      },
      {
        numbers: [[2, 2]],
        marks: [group(1, [1, 1, 1, 2], [3, 1, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_1_hint_2(),
      },
      {
        numbers: [[2, 1]],
        marks: [],
        text: () => m.minesweeper_pattern_triangle_1_hint_3(),
      },
      {
        numbers: [[2, 1]],
        marks: [group(1, [1, 1, 1, 2], [3, 1, 1, 1]), safe([1, 0, 3, 1])],
        text: () => m.minesweeper_pattern_triangle_1_hint_4(),
      },
    ],
  },
  {
    id: 'triangle_2',
    section: SECTION.triangles,
    title: () => m.minesweeper_pattern_triangle_2_title(),
    body: () => m.minesweeper_pattern_triangle_2_body(),
    rows: ['...X', '#1.~', '.2??', '#?00'],
    open: true,
    goal: {
      reveal: [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
      flag: [[0, 3]],
    },
    hints: [
      {
        numbers: [[1, 1]],
        marks: [group(undefined, [0, 1, 1, 2], [2, 1, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_2_hint_1(),
      },
      {
        numbers: [[1, 1]],
        marks: [group(undefined, [0, 1, 1, 2], [2, 1, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_2_hint_2(),
      },
      {
        numbers: [[1, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_triangle_2_hint_3(),
      },
      {
        numbers: [[1, 2]],
        marks: [group(undefined, [0, 1, 1, 2], [2, 1, 1, 1]), mine([0, 3, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_2_hint_4(),
      },
      {
        numbers: [[1, 1]],
        marks: [group(1, [0, 1, 1, 2], [2, 1, 1, 1]), safe([0, 0, 3, 1])],
        text: () => m.minesweeper_pattern_triangle_2_hint_5(),
      },
    ],
  },
  {
    id: 'triangle_3',
    section: SECTION.triangles,
    title: () => m.minesweeper_pattern_triangle_3_title(),
    body: () => m.minesweeper_pattern_triangle_3_body(),
    rows: ['...X', '#2.~', '#3??', '#?00'],
    open: true,
    goal: {
      reveal: [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
      flag: [[0, 3]],
    },
    hints: [
      {
        numbers: [[1, 1]],
        marks: [group(undefined, [0, 1, 1, 2], [2, 1, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_3_hint_1(),
      },
      {
        numbers: [[1, 1]],
        marks: [group(undefined, [0, 1, 1, 2], [2, 1, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_3_hint_2(),
      },
      {
        numbers: [[1, 2]],
        marks: [],
        text: () => m.minesweeper_pattern_triangle_3_hint_3(),
      },
      {
        numbers: [[1, 2]],
        marks: [group(undefined, [0, 1, 1, 2], [2, 1, 1, 1]), mine([0, 3, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_3_hint_4(),
      },
      {
        numbers: [[1, 1]],
        marks: [group(2, [0, 1, 1, 2], [2, 1, 1, 1]), safe([0, 0, 3, 1])],
        text: () => m.minesweeper_pattern_triangle_3_hint_5(),
      },
    ],
  },
  {
    id: 'triangle_4',
    section: SECTION.triangles,
    title: () => m.minesweeper_pattern_triangle_4_title(),
    body: () => m.minesweeper_pattern_triangle_4_body(),
    rows: ['.###', '.24?', '..?#', 'X~~~'],
    open: true,
    goal: {
      reveal: [
        [0, 0],
        [0, 1],
        [0, 2],
      ],
      flag: [
        [3, 0],
        [3, 2],
      ],
    },
    hints: [
      {
        numbers: [[1, 1]],
        marks: [group(undefined, [1, 0, 2, 1], [1, 2, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_4_hint_1(),
      },
      {
        numbers: [[1, 1]],
        marks: [group(undefined, [1, 0, 2, 1], [1, 2, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_4_hint_2(),
      },
      {
        numbers: [[2, 1]],
        marks: [],
        text: () => m.minesweeper_pattern_triangle_4_hint_3(),
      },
      {
        numbers: [[2, 1]],
        marks: [group(undefined, [1, 0, 2, 1], [1, 2, 1, 1]), mine([3, 0, 1, 1], [3, 2, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_4_hint_4(),
      },
      {
        numbers: [[1, 1]],
        marks: [group(2, [1, 0, 2, 1], [1, 2, 1, 1]), safe([0, 0, 1, 3])],
        text: () => m.minesweeper_pattern_triangle_4_hint_5(),
      },
    ],
  },
  {
    id: 'triangle_5',
    section: SECTION.triangles,
    title: () => m.minesweeper_pattern_triangle_5_title(),
    body: () => m.minesweeper_pattern_triangle_5_body(),
    rows: ['~X~', '...', '?1?', '#2.', '#??'],
    open: true,
    goal: {
      reveal: [
        [0, 1],
        [1, 1],
        [2, 1],
      ],
      flag: [[0, 4]],
    },
    hints: [
      {
        numbers: [[1, 2]],
        marks: [group(undefined, [0, 3, 1, 1], [2, 3, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_5_hint_1(),
      },
      {
        numbers: [[1, 2]],
        marks: [group(undefined, [0, 3, 1, 1], [2, 3, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_5_hint_2(),
      },
      {
        numbers: [[1, 3]],
        marks: [],
        text: () => m.minesweeper_pattern_triangle_5_hint_3(),
      },
      {
        numbers: [[1, 3]],
        marks: [group(undefined, [0, 3, 1, 1], [2, 3, 1, 1]), mine([0, 4, 1, 1])],
        text: () => m.minesweeper_pattern_triangle_5_hint_4(),
      },
      {
        numbers: [[1, 2]],
        marks: [group(1, [0, 3, 1, 1], [2, 3, 1, 1]), safe([0, 1, 3, 1])],
        text: () => m.minesweeper_pattern_triangle_5_hint_5(),
      },
    ],
  },
  {
    id: 'corner_one_three_one',
    section: SECTION.complex,
    title: () => m.minesweeper_pattern_corner_one_three_one_title(),
    body: () => m.minesweeper_pattern_corner_one_three_one_body(),
    rows: ['.#.#', '?13.', '??1#', '~??.'],
    open: true,
    corner: {
      number: [2, 1],
      cell: [3, 0],
      also: [
        [0, 0],
        [3, 3],
      ],
    },
    goal: {
      reveal: [
        [0, 0],
        [3, 3],
      ],
      flag: [[3, 0]],
    },
    hints: [
      {
        numbers: [[2, 1]],
        marks: [group(3, [1, 0, 3, 1], [3, 1, 1, 2])],
        text: () => m.minesweeper_pattern_corner_one_three_one_hint_1(),
      },
      {
        numbers: [
          [1, 1],
          [2, 2],
        ],
        marks: [group(1, [0, 0, 3, 1]), group(1, [3, 1, 1, 3])],
        text: () => m.minesweeper_pattern_corner_one_three_one_hint_2(),
      },
      {
        numbers: [[2, 1]],
        marks: [mine([3, 0, 1, 1]), safe([0, 0, 1, 1], [3, 3, 1, 1])],
        text: () => m.minesweeper_pattern_corner_one_three_one_hint_3(),
      },
    ],
  },
  {
    id: 'corner_two_two_two',
    section: SECTION.complex,
    title: () => m.minesweeper_pattern_corner_two_two_two_title(),
    body: () => m.minesweeper_pattern_corner_two_two_two_body(),
    rows: ['##..', '?22#', '??2.', '~??#'],
    open: true,
    corner: {
      number: [2, 1],
      cell: [3, 0],
      also: [
        [0, 0],
        [3, 3],
      ],
    },
    goal: {
      reveal: [[3, 0]],
      flag: [
        [0, 0],
        [3, 3],
      ],
    },
    hints: [
      {
        numbers: [
          [1, 1],
          [2, 2],
        ],
        marks: [group(2, [0, 0, 3, 1]), group(2, [3, 1, 1, 3])],
        text: () => m.minesweeper_pattern_corner_two_two_two_hint_1(),
      },
      {
        numbers: [[2, 1]],
        marks: [group(2, [1, 0, 3, 1], [3, 1, 1, 2])],
        text: () => m.minesweeper_pattern_corner_two_two_two_hint_2(),
      },
      {
        numbers: [
          [1, 1],
          [2, 2],
        ],
        marks: [group(undefined, [1, 0, 2, 1]), group(undefined, [3, 1, 1, 2])],
        text: () => m.minesweeper_pattern_corner_two_two_two_hint_3(),
      },
      {
        numbers: [[2, 1]],
        marks: [safe([3, 0, 1, 1]), mine([0, 0, 1, 1], [3, 3, 1, 1])],
        text: () => m.minesweeper_pattern_corner_two_two_two_hint_4(),
      },
    ],
  },
  {
    id: 'gt_two_lt',
    section: SECTION.complex,
    title: () => m.minesweeper_pattern_gt_two_lt_title(),
    body: () => m.minesweeper_pattern_gt_two_lt_body(),
    rows: ['0?~~', '0?.X', '?1.~', '?#.~', '?2.~', '01#~', '0?.~'],
    open: true,
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
    rows: ['~~~~X', '~##..', '~?32.', '~#?.#', '??11?', '00000'],
    open: true,
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
    rows: ['?????', '?#1.?', '?.2.?', '?.2#?', '?#2.?', '?.2.?', '?.1#?', '?????'],
    open: true,
    goal: {
      reveal: [
        [1, 2],
        [3, 2],
        [1, 5],
        [3, 5],
      ],
      flag: [],
    },
    hints: [
      {
        numbers: [[2, 1]],
        marks: [],
        text: () => m.minesweeper_pattern_chain_hint_1(),
      },
      {
        numbers: [
          [2, 1],
          [2, 2],
        ],
        marks: [group(1, [1, 1, 1, 2], [3, 1, 1, 2]), group(1, [1, 3, 1, 1], [3, 3, 1, 1])],
        text: () => m.minesweeper_pattern_chain_hint_2(),
      },
      {
        numbers: [[2, 6]],
        marks: [],
        text: () => m.minesweeper_pattern_chain_hint_3(),
      },
      {
        numbers: [
          [2, 6],
          [2, 5],
        ],
        marks: [group(1, [1, 5, 1, 2], [3, 5, 1, 2]), group(1, [1, 4, 1, 1], [3, 4, 1, 1])],
        text: () => m.minesweeper_pattern_chain_hint_4(),
      },
      {
        numbers: [[2, 3]],
        marks: [
          group(1, [1, 3, 1, 1], [3, 3, 1, 1]),
          group(1, [1, 4, 1, 1], [3, 4, 1, 1]),
          safe([1, 2, 1, 1], [3, 2, 1, 1]),
        ],
        text: () => m.minesweeper_pattern_chain_hint_5(),
      },
      {
        numbers: [[2, 4]],
        marks: [
          group(1, [1, 3, 1, 1], [3, 3, 1, 1]),
          group(1, [1, 4, 1, 1], [3, 4, 1, 1]),
          safe([1, 5, 1, 1], [3, 5, 1, 1]),
        ],
        text: () => m.minesweeper_pattern_chain_hint_6(),
      },
    ],
  },
  {
    id: 'mine_counting',
    section: SECTION.endgame,
    title: () => m.minesweeper_pattern_mine_counting_title(),
    body: () => m.minesweeper_pattern_mine_counting_body(),
    rows: ['#.?#.#', '?1??2?', '??????', '..?...'],
    goal: {
      reveal: [
        [0, 3],
        [1, 3],
        [3, 3],
        [4, 3],
        [5, 3],
      ],
      flag: [],
    },
    hints: [
      {
        numbers: [[1, 1]],
        marks: [group(1, [0, 0, 2, 1])],
        text: () => m.minesweeper_pattern_mine_counting_hint_1(),
      },
      {
        numbers: [[4, 1]],
        marks: [group(2, [3, 0, 3, 1])],
        text: () => m.minesweeper_pattern_mine_counting_hint_2(),
      },
      {
        numbers: [],
        marks: [safe([0, 3, 2, 1], [3, 3, 3, 1])],
        text: () => m.minesweeper_pattern_mine_counting_hint_3(),
      },
    ],
  },
  {
    id: 'combinations',
    section: SECTION.endgame,
    title: () => m.minesweeper_pattern_combinations_title(),
    body: () => m.minesweeper_pattern_combinations_body(),
    rows: ['00000', '?1?1?', '.?#?.'],
    goal: {
      reveal: [
        [0, 2],
        [4, 2],
      ],
      flag: [[2, 2]],
    },
    hints: [
      {
        numbers: [[1, 1]],
        marks: [group(undefined, [0, 2, 1, 1])],
        text: () => m.minesweeper_pattern_combinations_hint_1(),
      },
      {
        numbers: [
          [1, 1],
          [3, 1],
        ],
        marks: [group(undefined, [0, 2, 1, 1])],
        text: () => m.minesweeper_pattern_combinations_hint_2(),
      },
      {
        numbers: [
          [1, 1],
          [3, 1],
        ],
        marks: [group(undefined, [0, 2, 1, 1])],
        text: () => m.minesweeper_pattern_combinations_hint_3(),
      },
      {
        numbers: [
          [1, 1],
          [3, 1],
        ],
        marks: [safe([0, 2, 1, 1], [4, 2, 1, 1]), mine([2, 2, 1, 1])],
        text: () => m.minesweeper_pattern_combinations_hint_4(),
      },
    ],
  },
];
