import { Logger } from '@nestjs/common';
import { PENDING_HOLD_CUTOFF_SQL } from './seat-hold';

/**
 * THE PER-QUESTION RESULTS OF A FORM, COMPUTED BY THE DATABASE (G-RESULTS, owner, 2026-11-21).
 *
 * A manager's "Resume" tab used to count in the browser, from every answer the responses list had
 * already shipped, and only for choice questions. This is the same view, read by SQL aggregates
 * (`GROUP BY` over the answers' jsonb): the payload is one number per option, cell or scale step,
 * whatever the number of answers, so a form of a thousand answers costs the client a few kilobytes.
 *
 * WHICH ANSWERS COUNT (`COUNTED_ANSWER_SQL`): the ones that are a person's answer now - paid, free,
 * waiting for cash, paid over capacity, and an online payment still within its hold. A refunded,
 * cancelled or expired answer says the person is not in, so their vote is not either - the rule the
 * browser-side tab already applied, now written once in SQL beside the seat-hold rule it mirrors.
 *
 * THE DENOMINATOR IS ALWAYS STATED: every question carries `answered` - the counted answers that
 * gave it an answer - and a percentage is a count over THAT, never over the form's total (a
 * question behind a condition is answered by few). A multiple-choice question counts each pick, so
 * its percentages may add up past 100.
 *
 * THE ANONYMITY FLOOR (charter principle 1, `docs/wiki/frontend/modules/forms.md`): on an anonymous
 * form a question is shown only once at least `ANONYMOUS_MIN_ANSWERS` answers gave it an answer. A
 * breakdown of one or two answers is not a statistic, it is those answers read out. There are NO
 * cross-tabs - no question split by another, none by promo or formation - because a split is how a
 * floor of five over the whole becomes a cell of one.
 */

/** The fewest answers to a question on an ANONYMOUS form before its breakdown is shown. */
export const ANONYMOUS_MIN_ANSWERS = 5;

/** Answers that are a person's answer now, as SQL on a `submissions s` row. See the header. */
export const COUNTED_ANSWER_SQL = `(
  s."paymentStatus" IN ('paid', 'free', 'pending_cash', 'paid_over_capacity')
  OR (s."paymentStatus" = 'pending' AND s."paymentRequestedAt" > ${PENDING_HOLD_CUTOFF_SQL})
)`;

/** Runs one parameterised statement: the repository's `query`, or a test double. */
export type ResultsQuery = (sql: string, params: unknown[]) => Promise<Record<string, any>[]>;

/** The subset of a stored question these results read. */
export interface ResultsItem {
  id: string;
  label?: string;
  type?: string;
  options?: { id?: string; label?: string }[] | null;
  rows?: string[] | null;
  scale?: { min?: number; max?: number } | null;
  productGrid?: {
    rows?: { id: string; label: string }[];
    columns?: { id: string; label: string }[];
    closedCells?: string[];
  } | null;
}

interface Base {
  id: string;
  label: string;
}

/** Withheld: an anonymous form's question with fewer than `ANONYMOUS_MIN_ANSWERS` answers. */
export interface SuppressedResult extends Base {
  kind: 'choice' | 'scale' | 'matrix' | 'grid' | 'text';
  suppressed: true;
}

export interface ChoiceResult extends Base {
  kind: 'choice';
  suppressed: false;
  multiple: boolean;
  answered: number;
  options: { id: string; label: string; count: number }[];
  /** Picks that name no declared option (an answer older than a rename, an "Autre" write-in). */
  unlisted: number;
}

export interface ScaleResult extends Base {
  kind: 'scale';
  suppressed: false;
  answered: number;
  min: number;
  max: number;
  distribution: { value: number; count: number }[];
  /** Null when nobody answered inside the scale. */
  mean: number | null;
}

export interface MatrixResult extends Base {
  kind: 'matrix';
  suppressed: false;
  multiple: boolean;
  answered: number;
  columns: { id: string; label: string }[];
  rows: { label: string; counts: number[] }[];
}

export interface GridResult extends Base {
  kind: 'grid';
  suppressed: false;
  /** Answers that ordered at least one unit. */
  answered: number;
  totalUnits: number;
  columns: { id: string; label: string }[];
  rows: { id: string; label: string; units: number[] }[];
  closedCells: string[];
}

export interface TextResult extends Base {
  kind: 'text';
  suppressed: false;
  answered: number;
}

export type QuestionResult =
  | SuppressedResult
  | ChoiceResult
  | ScaleResult
  | MatrixResult
  | GridResult
  | TextResult;

export interface FormResults {
  /** The counted answers of the form: the denominator of nothing, shown as the headline. */
  totalAnswers: number;
  anonymous: boolean;
  /** The floor an anonymous form applies; null on a named form. */
  minAnswers: number | null;
  questions: QuestionResult[];
}

const logger = new Logger('FormResults');

const CHOICE_SINGLE = new Set(['single_choice', 'dropdown', 'single']);
const TEXT_TYPES = new Set(['short_text', 'long_text']);
const MATRIX_TYPES = new Set(['matrix_single', 'matrix_multiple']);

/**
 * ONE PASS PER ANSWER ROW: `jsonb_each(s.answers)` yields each question's answer once, and each
 * statement keeps the ids of its own family (`a.item_id = ANY($2)`). Looking each question up
 * (`answers -> id`, per row per question) instead cost a function scan per row PER QUESTION -
 * 300 ms on production's 690 counted answers for a statement that is now one scan per row.
 * `join` adds a lateral expansion of the answer (`a.val`) before the filter.
 */
const fromCounted = (join = '') => `FROM submissions s
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(s.answers) = 'object' THEN s.answers ELSE '{}'::jsonb END
  ) AS a(item_id, val)
  ${join}
  WHERE s."formId" = $1 AND ${COUNTED_ANSWER_SQL} AND a.item_id = ANY($2::text[])`;

/** A jsonb array (or nothing) as rows: the guard keeps `jsonb_array_elements_text` from erroring. */
const ELEMENTS_OF = (expr: string, alias: string) => `CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE jsonb_typeof(${expr}) WHEN 'array' THEN ${expr} WHEN 'string' THEN jsonb_build_array(${expr}) ELSE '[]'::jsonb END
  ) AS ${alias}`;

/**
 * Counted answers that gave each question a non-empty string, list or object. A number is no
 * answer here: a scale's `answered` is the sum of its own distribution, a single choice's of its
 * own picks (so a stray shape never makes the denominator disagree with the bars it divides).
 */
export const ANSWERED_SQL = `SELECT a.item_id AS "itemId", count(*)::int AS n ${fromCounted()}
  AND CASE jsonb_typeof(a.val)
    WHEN 'string' THEN a.val #>> '{}' <> ''
    WHEN 'array' THEN jsonb_array_length(a.val) > 0
    WHEN 'object' THEN a.val <> '{}'::jsonb
    ELSE false END
  GROUP BY a.item_id`;

export const SINGLE_SQL = `SELECT a.item_id AS "itemId", a.val #>> '{}' AS value, count(*)::int AS n ${fromCounted()}
  AND jsonb_typeof(a.val) = 'string' AND a.val #>> '{}' <> ''
  GROUP BY a.item_id, value`;

/**
 * Counted answers that gave a multiple-choice question a non-empty LIST, the shape `MULTIPLE_SQL`
 * reads its picks from: a string there is no pick, so it must not enter the denominator either.
 */
export const MULTIPLE_ANSWERED_SQL = `SELECT a.item_id AS "itemId", count(*)::int AS n ${fromCounted()}
  AND jsonb_typeof(a.val) = 'array' AND jsonb_array_length(a.val) > 0
  GROUP BY a.item_id`;

/** A multiple-choice answer is a list of option ids: one pick per element. */
export const MULTIPLE_SQL = `SELECT a.item_id AS "itemId", v.value AS value, count(*)::int AS n
  ${fromCounted(ELEMENTS_OF('a.val', 'v(value)'))}
  AND jsonb_typeof(a.val) = 'array'
  GROUP BY a.item_id, v.value`;

/** A scale answer is a number, or the digits of one an older client sent as a string. */
export const SCALE_SQL = `SELECT a.item_id AS "itemId", v.value AS value, count(*)::int AS n
  ${fromCounted(`CROSS JOIN LATERAL (SELECT CASE
    WHEN jsonb_typeof(a.val) = 'number' THEN (a.val #>> '{}')::numeric
    WHEN jsonb_typeof(a.val) = 'string' AND a.val #>> '{}' ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (a.val #>> '{}')::numeric
    END AS value) v`)}
  AND v.value IS NOT NULL
  GROUP BY a.item_id, v.value`;

/** A survey grid is an object row -> column id, or row -> list of column ids. */
export const MATRIX_SQL = `SELECT a.item_id AS "itemId", r.row_label AS "row", c.col AS col, count(*)::int AS n
  ${fromCounted(`CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(a.val) = 'object' THEN a.val ELSE '{}'::jsonb END
  ) AS r(row_label, cell)
  ${ELEMENTS_OF('r.cell', 'c(col)')}`)}
  GROUP BY a.item_id, r.row_label, c.col`;

/**
 * A priced grid is an object "row:column" -> quantity. The sum is a `bigint` (pg hands it back as a
 * string, which `num` reads), so a large quantity can never overflow an `int` and fail the read.
 */
export const GRID_SQL = `SELECT a.item_id AS "itemId", g.cell_key AS cell, sum(g.qty)::bigint AS units
  ${fromCounted(`CROSS JOIN LATERAL (
    SELECT e.cell_key,
      CASE WHEN jsonb_typeof(e.qty_json) = 'number' THEN (e.qty_json #>> '{}')::numeric ELSE 0 END AS qty
    FROM jsonb_each(
      CASE WHEN jsonb_typeof(a.val) = 'object' THEN a.val ELSE '{}'::jsonb END
    ) AS e(cell_key, qty_json)
  ) g`)}
  GROUP BY a.item_id, g.cell_key`;

/** The grid-wide count of answers that ordered anything, which a per-cell count cannot give. */
export const GRID_ORDERERS_SQL = `SELECT a.item_id AS "itemId", count(DISTINCT s.id)::int AS n
  ${fromCounted(`CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(a.val) = 'object' THEN a.val ELSE '{}'::jsonb END
  ) AS e(cell_key, qty_json)`)}
  AND jsonb_typeof(e.qty_json) = 'number' AND (e.qty_json #>> '{}')::numeric > 0
  GROUP BY a.item_id`;

export const COUNT_SQL = `SELECT count(*)::int AS n FROM submissions s
  WHERE s."formId" = $1 AND ${COUNTED_ANSWER_SQL}`;

/** `itemId` -> rows, for a statement run once over the ids of one family of questions. */
async function grouped(
  query: ResultsQuery,
  sql: string,
  formId: string,
  ids: string[]
): Promise<Map<string, Record<string, any>[]>> {
  const out = new Map<string, Record<string, any>[]>();
  if (ids.length === 0) return out;
  for (const row of await query(sql, [formId, ids])) {
    const bucket = out.get(row.itemId) ?? [];
    bucket.push(row);
    out.set(row.itemId, bucket);
  }
  return out;
}

/** A numeric aggregate comes back from pg as a string or a number; always a number here. */
const num = (value: unknown): number => Number(value ?? 0);

const labelOf = (item: ResultsItem): string => item.label ?? item.id;

/** Which family of result a stored question is read as, or null when it has no results. */
function kindOf(item: ResultsItem): QuestionResult['kind'] | null {
  const type = item.type ?? '';
  if (CHOICE_SINGLE.has(type) || type === 'multiple_choice') return 'choice';
  if (type === 'linear_scale') return 'scale';
  if (MATRIX_TYPES.has(type)) return 'matrix';
  if (type === 'product_grid') return 'grid';
  if (TEXT_TYPES.has(type)) return 'text';
  return null;
}

/**
 * Whether an anonymous form's question may be shown at `answered` answers. Exported for the test
 * that pins the boundary: a floor is the number a test names, never a comment.
 */
export function meetsAnonymityFloor(anonymous: boolean, answered: number): boolean {
  return !anonymous || answered >= ANONYMOUS_MIN_ANSWERS;
}

/**
 * The results of one form: a headline count and one entry per question that has results.
 *
 * Nine statements at most, each over the ids of one family of questions, whatever the form's size;
 * `query` is injected so the shaping is tested without a database, and the SQL by
 * `form-results.integration.spec.ts` against a real one.
 */
export async function computeFormResults(
  query: ResultsQuery,
  form: { id: string; anonymous: boolean; items: ResultsItem[] | null | undefined }
): Promise<FormResults> {
  const items = (form.items ?? []).filter((item) => item && typeof item.id === 'string');
  const anonymous = form.anonymous === true;
  const byKind = (types: (it: ResultsItem) => boolean) =>
    items.filter(types).map((item) => item.id);

  const [{ n: totalAnswers }] = await query(COUNT_SQL, [form.id]);
  const singleIds = byKind((i) => CHOICE_SINGLE.has(i.type ?? ''));
  const multipleIds = byKind((i) => i.type === 'multiple_choice');
  const scaleIds = byKind((i) => i.type === 'linear_scale');
  const matrixIds = byKind((i) => MATRIX_TYPES.has(i.type ?? ''));
  const gridIds = byKind((i) => i.type === 'product_grid');
  // The questions `ANSWERED_SQL` counts: every family that is neither a grid, a list of picks, nor
  // read from its own distribution.
  const answeredIds = byKind((i) => kindOf(i) === 'text' || kindOf(i) === 'matrix');

  const [answeredRows, multipleAnswered, single, multiple, scale, matrix, grid, orderers] =
    await Promise.all([
      grouped(query, ANSWERED_SQL, form.id, answeredIds),
      grouped(query, MULTIPLE_ANSWERED_SQL, form.id, multipleIds),
      grouped(query, SINGLE_SQL, form.id, singleIds),
      grouped(query, MULTIPLE_SQL, form.id, multipleIds),
      grouped(query, SCALE_SQL, form.id, scaleIds),
      grouped(query, MATRIX_SQL, form.id, matrixIds),
      grouped(query, GRID_SQL, form.id, gridIds),
      grouped(query, GRID_ORDERERS_SQL, form.id, gridIds),
    ]);

  const questions: QuestionResult[] = [];
  let suppressed = 0;
  for (const item of items) {
    const kind = kindOf(item);
    if (kind === null) continue;
    const base = { id: item.id, label: labelOf(item) };
    const sumOf = (rows: Record<string, any>[] | undefined) =>
      (rows ?? []).reduce((total, row) => total + num(row.n), 0);
    const answered =
      kind === 'grid'
        ? num(orderers.get(item.id)?.[0]?.n)
        : kind === 'scale'
          ? sumOf(scale.get(item.id)?.filter((row) => withinScale(item, num(row.value))))
          : CHOICE_SINGLE.has(item.type ?? '')
            ? sumOf(single.get(item.id))
            : item.type === 'multiple_choice'
              ? num(multipleAnswered.get(item.id)?.[0]?.n)
              : num(answeredRows.get(item.id)?.[0]?.n);
    if (!meetsAnonymityFloor(anonymous, answered)) {
      suppressed += 1;
      questions.push({ ...base, kind, suppressed: true });
      continue;
    }
    switch (kind) {
      case 'text':
        questions.push({ ...base, kind, suppressed: false, answered });
        break;
      case 'choice': {
        const rows = (item.type === 'multiple_choice' ? multiple : single).get(item.id) ?? [];
        questions.push(choiceResult(item, base, rows, answered));
        break;
      }
      case 'scale':
        questions.push(scaleResult(item, base, scale.get(item.id) ?? [], answered));
        break;
      case 'matrix':
        questions.push(matrixResult(item, base, matrix.get(item.id) ?? [], answered));
        break;
      case 'grid':
        questions.push(gridResult(item, base, grid.get(item.id) ?? [], answered));
        break;
    }
  }
  if (suppressed > 0) {
    logger.log(
      `[FORMS] results of ${form.id.slice(0, 8)}: ${suppressed} question(s) withheld below the ` +
        `anonymity floor of ${ANONYMOUS_MIN_ANSWERS}`
    );
  }
  return {
    totalAnswers: num(totalAnswers),
    anonymous,
    minAnswers: anonymous ? ANONYMOUS_MIN_ANSWERS : null,
    questions,
  };
}

function choiceResult(
  item: ResultsItem,
  base: Base,
  rows: Record<string, any>[],
  answered: number
): ChoiceResult {
  const options = (item.options ?? []).map((option) => ({
    id: option.id ?? option.label ?? '',
    label: option.label ?? option.id ?? '',
    count: 0,
  }));
  let unlisted = 0;
  for (const row of rows) {
    // An answer names an option by its id, or - on an older form - by its label.
    const hit =
      options.find((o) => o.id === row.value) ?? options.find((o) => o.label === row.value);
    if (hit) hit.count += num(row.n);
    else unlisted += num(row.n);
  }
  return {
    ...base,
    kind: 'choice',
    suppressed: false,
    multiple: item.type === 'multiple_choice',
    answered,
    options,
    unlisted,
  };
}

/** A scale's bounds as stored, or the builder's default 1-5 when the question carries none. */
function scaleBounds(item: ResultsItem): { min: number; max: number } {
  return {
    min: Number.isInteger(item.scale?.min) ? (item.scale!.min as number) : 1,
    max: Number.isInteger(item.scale?.max) ? (item.scale!.max as number) : 5,
  };
}

/** Whether a stored scale answer is a whole step of the scale: the only kind a bar can show. */
function withinScale(item: ResultsItem, value: number): boolean {
  const { min, max } = scaleBounds(item);
  return Number.isInteger(value) && value >= min && value <= max;
}

function scaleResult(
  item: ResultsItem,
  base: Base,
  rows: Record<string, any>[],
  answered: number
): ScaleResult {
  const { min, max } = scaleBounds(item);
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(num(row.value), num(row.n));
  const distribution: { value: number; count: number }[] = [];
  let inside = 0;
  let sum = 0;
  for (let value = min; value <= max; value += 1) {
    const count = counts.get(value) ?? 0;
    distribution.push({ value, count });
    inside += count;
    sum += value * count;
  }
  return {
    ...base,
    kind: 'scale',
    suppressed: false,
    answered,
    min,
    max,
    distribution,
    mean: inside > 0 ? sum / inside : null,
  };
}

function matrixResult(
  item: ResultsItem,
  base: Base,
  rows: Record<string, any>[],
  answered: number
): MatrixResult {
  const columns = (item.options ?? []).map((option) => ({
    id: option.id ?? option.label ?? '',
    label: option.label ?? option.id ?? '',
  }));
  const at = new Map<string, number>();
  for (const row of rows) at.set(`${row.row}\u0000${row.col}`, num(row.n));
  return {
    ...base,
    kind: 'matrix',
    suppressed: false,
    multiple: item.type === 'matrix_multiple',
    answered,
    columns,
    rows: (item.rows ?? []).map((label) => ({
      label,
      counts: columns.map((column) => at.get(`${label}\u0000${column.id}`) ?? 0),
    })),
  };
}

function gridResult(
  item: ResultsItem,
  base: Base,
  rows: Record<string, any>[],
  answered: number
): GridResult {
  const grid = item.productGrid ?? {};
  const columns = (grid.columns ?? []).map(({ id, label }) => ({ id, label }));
  const units = new Map<string, number>();
  for (const row of rows) units.set(row.cell, num(row.units));
  let totalUnits = 0;
  const gridRows = (grid.rows ?? []).map((row) => {
    const perColumn = columns.map((column) => units.get(`${row.id}:${column.id}`) ?? 0);
    totalUnits += perColumn.reduce((a, b) => a + b, 0);
    return { id: row.id, label: row.label, units: perColumn };
  });
  return {
    ...base,
    kind: 'grid',
    suppressed: false,
    answered,
    totalUnits,
    columns,
    rows: gridRows,
    closedCells: grid.closedCells ?? [],
  };
}
