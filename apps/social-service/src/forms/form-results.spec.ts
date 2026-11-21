import {
  ANONYMOUS_MIN_ANSWERS,
  ANSWERED_SQL,
  COUNTED_ANSWER_SQL,
  COUNT_SQL,
  GRID_ORDERERS_SQL,
  GRID_SQL,
  MATRIX_SQL,
  MULTIPLE_SQL,
  SCALE_SQL,
  SINGLE_SQL,
  computeFormResults,
  meetsAnonymityFloor,
  type ResultsItem,
  type ResultsQuery,
} from './form-results';

/**
 * THE SHAPING OF THE RESULTS, AGAINST A QUERY DOUBLE - the SQL itself is proven against a real
 * database by `form-results.integration.spec.ts`. What is pinned here: each family of question is
 * read as the right shape, a missing option still shows at 0, the denominator is the question's own
 * `answered`, the anonymity floor withholds a thin question, and a form with no question asks the
 * database only for its headline count.
 */
const items: ResultsItem[] = [
  {
    id: 'c1',
    label: 'Colour',
    type: 'single_choice',
    options: [
      { id: 'o1', label: 'Red' },
      { id: 'o2', label: 'Blue' },
    ],
  },
  {
    id: 'm1',
    label: 'Days',
    type: 'multiple_choice',
    options: [
      { id: 'd1', label: 'Mon' },
      { id: 'd2', label: 'Tue' },
    ],
  },
  { id: 's1', label: 'Mood', type: 'linear_scale', scale: { min: 1, max: 5 } },
  {
    id: 'x1',
    label: 'Rate',
    type: 'matrix_single',
    rows: ['Food', 'Music'],
    options: [
      { id: 'g', label: 'Good' },
      { id: 'b', label: 'Bad' },
    ],
  },
  {
    id: 'g1',
    label: 'Order',
    type: 'product_grid',
    productGrid: {
      rows: [{ id: 'r1', label: 'Green' }],
      columns: [
        { id: 'k1', label: 'M' },
        { id: 'k2', label: 'L' },
      ],
      closedCells: ['r1:k2'],
    },
  },
  { id: 't1', label: 'Why', type: 'long_text' },
  { id: 'f1', label: 'CV', type: 'file' },
];

/** A database double: each exported statement answers with its own canned rows. */
function fake(total: number, answered: Record<string, number>) {
  const calls: string[] = [];
  const run: ResultsQuery = async (sql) => {
    calls.push(sql);
    switch (sql) {
      case COUNT_SQL:
        return [{ n: total }];
      case ANSWERED_SQL:
        return Object.entries(answered)
          .filter(([id]) => id !== 'g1')
          .map(([itemId, n]) => ({ itemId, n }));
      case SINGLE_SQL:
        return [
          { itemId: 'c1', value: 'o1', n: 3 },
          { itemId: 'c1', value: 'Blue', n: 1 }, // an older answer naming the label
          { itemId: 'c1', value: 'autre:1', n: 2 }, // names no declared option
        ];
      case MULTIPLE_SQL:
        return [
          { itemId: 'm1', value: 'd1', n: 4 },
          { itemId: 'm1', value: 'd2', n: 2 },
        ];
      case SCALE_SQL:
        return [
          { itemId: 's1', value: '4', n: 2 },
          { itemId: 's1', value: '5', n: 2 },
          { itemId: 's1', value: '9', n: 7 }, // outside the scale: ignored
        ];
      case MATRIX_SQL:
        return [
          { itemId: 'x1', row: 'Food', col: 'g', n: 5 },
          { itemId: 'x1', row: 'Music', col: 'b', n: 1 },
        ];
      case GRID_SQL:
        return [{ itemId: 'g1', cell: 'r1:k1', units: 7 }];
      case GRID_ORDERERS_SQL:
        return answered.g1 ? [{ itemId: 'g1', n: answered.g1 }] : [];
      default:
        throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
    }
  };
  return { run, calls };
}

describe('computeFormResults', () => {
  const form = (anonymous: boolean) => ({ id: 'abcdef12-0000', anonymous, items });

  it('reads every family of question, and skips a type with no results', async () => {
    const db = fake(10, { c1: 6, m1: 6, s1: 4, x1: 6, t1: 9, g1: 5 });
    const out = await computeFormResults(db.run, form(false));
    expect(out.totalAnswers).toBe(10);
    expect(out.minAnswers).toBeNull();
    expect(out.questions.map((q) => q.id)).toEqual(['c1', 'm1', 's1', 'x1', 'g1', 't1']);

    const [choice, multi, scale, matrix, grid, text] = out.questions as any[];
    expect(choice.options).toEqual([
      { id: 'o1', label: 'Red', count: 3 },
      { id: 'o2', label: 'Blue', count: 1 },
    ]);
    expect(choice.unlisted).toBe(2);
    expect(choice.answered).toBe(6);
    expect(multi.multiple).toBe(true);
    expect(multi.options.map((o: any) => o.count)).toEqual([4, 2]);
    // (4 * 2 + 5 * 2) over the 4 answers inside the scale; the 7 at 9 never move the mean.
    expect(scale.mean).toBe(4.5);
    expect(scale.answered).toBe(4);
    expect(scale.distribution).toHaveLength(5);
    expect(scale.distribution[0]).toEqual({ value: 1, count: 0 });
    expect(matrix.rows).toEqual([
      { label: 'Food', counts: [5, 0] },
      { label: 'Music', counts: [0, 1] },
    ]);
    expect(grid.rows).toEqual([{ id: 'r1', label: 'Green', units: [7, 0] }]);
    expect(grid.totalUnits).toBe(7);
    expect(grid.answered).toBe(5);
    expect(grid.closedCells).toEqual(['r1:k2']);
    expect(text).toMatchObject({ kind: 'text', answered: 9 });
  });

  it('has no mean for a scale nobody answered, and states 0 answers rather than hiding it', async () => {
    const db = fake(0, {});
    const empty: ResultsQuery = async (sql, params) =>
      sql === SCALE_SQL ? [] : db.run(sql, params);
    const out = await computeFormResults(empty, form(false));
    const scale = out.questions.find((q) => q.id === 's1') as any;
    expect(scale.mean).toBeNull();
    expect(scale.answered).toBe(0);
  });

  it('withholds an anonymous question below the floor, and only that one', async () => {
    const db = fake(10, { c1: ANONYMOUS_MIN_ANSWERS - 1, m1: ANONYMOUS_MIN_ANSWERS, t1: 1, g1: 0 });
    // 4 picks on the single choice, one answer on the scale: both below the floor of 5.
    const thin: ResultsQuery = async (sql, params) =>
      sql === SINGLE_SQL
        ? [{ itemId: 'c1', value: 'o1', n: ANONYMOUS_MIN_ANSWERS - 1 }]
        : sql === SCALE_SQL
          ? [{ itemId: 's1', value: '4', n: 1 }]
          : db.run(sql, params);
    const out = await computeFormResults(thin, form(true));
    expect(out.minAnswers).toBe(ANONYMOUS_MIN_ANSWERS);
    const byId = Object.fromEntries(out.questions.map((q) => [q.id, q])) as any;
    expect(byId.c1).toEqual({ id: 'c1', label: 'Colour', kind: 'choice', suppressed: true });
    expect(byId.m1.suppressed).toBe(false);
    expect(byId.t1.suppressed).toBe(true);
    expect(byId.s1.suppressed).toBe(true);
    expect(byId.g1.suppressed).toBe(true);
    // Withheld means NO figure of that question leaves, not even its answered count.
    expect(JSON.stringify(byId.c1)).not.toContain('answered');
  });

  it('pins the floor boundary: 4 hidden, 5 shown, a named form never hidden', () => {
    expect(ANONYMOUS_MIN_ANSWERS).toBe(5);
    expect(meetsAnonymityFloor(true, 4)).toBe(false);
    expect(meetsAnonymityFloor(true, 5)).toBe(true);
    expect(meetsAnonymityFloor(false, 0)).toBe(true);
  });

  it('asks only for the headline count when the form has no question', async () => {
    const db = fake(3, {});
    const out = await computeFormResults(db.run, { id: 'f', anonymous: false, items: [] });
    expect(out).toMatchObject({ totalAnswers: 3, questions: [] });
    expect(db.calls).toEqual([COUNT_SQL]);
  });

  it("counts what is a person's answer now: never a refunded, cancelled or expired one", () => {
    expect(COUNTED_ANSWER_SQL).toContain("'paid', 'free', 'pending_cash', 'paid_over_capacity'");
    expect(COUNTED_ANSWER_SQL).not.toMatch(/refunded|cancelled|expired/);
    expect(COUNTED_ANSWER_SQL).toContain('s."paymentStatus" = \'pending\' AND');
  });
});
