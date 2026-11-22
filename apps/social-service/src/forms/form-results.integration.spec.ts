/**
 * THE RESULTS SQL AGAINST A REAL PostgreSQL (G-RESULTS): every family of question over answers of
 * the shapes the forms store - a choice by id, by an old label and by something undeclared, a list
 * of picks, a scale as a number and as a string, a survey grid of both kinds, a priced grid, a text,
 * and the garbage a jsonb column can hold (a number where a list is expected, an empty object).
 *
 * What only the database shows: the jsonb operators accept every one of those shapes without an
 * error, `GROUP BY` counts them, and a refunded, cancelled or expired answer is not counted.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Everything happens in a throwaway schema, dropped at the end.
 */
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { FormReminder } from './entities/form-reminder.entity';
import { OpeningReminder } from '../openings/entities/opening-reminder.entity';
import { FormRespondent } from './entities/form-respondent.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { computeFormResults, type ResultsItem } from './form-results';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

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
    type: 'matrix_multiple',
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
      closedCells: [],
    },
  },
  { id: 't1', label: 'Why', type: 'long_text' },
];

maybe('form results against PostgreSQL', () => {
  const schema = `results_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let formId: string;
  let anonymousId: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Form, Submission, FormReminder, OpeningReminder, FormRespondent, PurchaseRecord],
      synchronize: true,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();

    const forms = ds.getRepository(Form);
    const subs = ds.getRepository(Submission);
    const mk = async (anonymous: boolean) =>
      (
        await forms.save(
          forms.create({
            ownerId: 'owner',
            title: 'results',
            basePrice: 0,
            currency: 'eur',
            requiresPayment: false,
            allowMultipleSubmissions: true,
            anonymous,
            items,
          } as Partial<Form>)
        )
      ).id;
    formId = await mk(false);
    anonymousId = await mk(true);

    const answer = async (id: string, answers: object, paymentStatus = 'free') =>
      subs.save(subs.create({ formId: id, answers, paymentStatus } as Partial<Submission>));
    await answer(formId, {
      c1: 'o1',
      m1: ['d1', 'd2'],
      s1: 4,
      x1: { Food: ['g'], Music: ['g', 'b'] },
      g1: { 'r1:k1': 2, 'r1:k2': 0 },
      t1: 'because',
    });
    await answer(formId, { c1: 'Blue', m1: ['d1'], s1: '5', x1: { Food: ['b'] }, g1: {}, t1: '' });
    // A string where a list belongs is no pick, and no answered either.
    await answer(formId, { m1: 'd1' });
    await answer(formId, { c1: 'autre: x', m1: 3, s1: 'n/a', x1: {}, g1: { 'r1:k1': 1 } });
    // Not a person's answer now: none of these may be counted.
    await answer(formId, { c1: 'o1', g1: { 'r1:k1': 9 } }, 'refunded');
    await answer(formId, { c1: 'o1' }, 'cancelled');
    await answer(formId, { c1: 'o1' }, 'expired');
    // An answer that holds: waiting for cash, and paid over capacity.
    await answer(formId, { c1: 'o2', g1: { 'r1:k2': 3 } }, 'pending_cash');
    for (let i = 0; i < 6; i += 1) await answer(anonymousId, { c1: 'o1' });
    for (let i = 0; i < 4; i += 1) await answer(anonymousId, { s1: 3 });
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const run = (id: string, anonymous: boolean) =>
    computeFormResults((sql, params) => ds.query(sql, params), { id, anonymous, items });

  it('counts every shape, and only the answers that count', async () => {
    const out = await run(formId, false);
    expect(out.totalAnswers).toBe(5);
    const by = Object.fromEntries(out.questions.map((q) => [q.id, q])) as any;

    expect(by.c1.answered).toBe(4);
    expect(by.c1.options.map((o: any) => o.count)).toEqual([1, 2]);
    expect(by.c1.unlisted).toBe(1);
    // The 3 stored as a number where a list belongs is no pick and no error.
    expect(by.m1.options.map((o: any) => o.count)).toEqual([2, 1]);
    expect(by.m1.answered).toBe(2);
    // A number and its string form both count; text that is no number does not.
    expect(by.s1.distribution.find((d: any) => d.value === 4).count).toBe(1);
    expect(by.s1.distribution.find((d: any) => d.value === 5).count).toBe(1);
    expect(by.s1.mean).toBe(4.5);
    expect(by.s1.answered).toBe(2);
    expect(by.x1.rows).toEqual([
      { label: 'Food', counts: [1, 1] },
      { label: 'Music', counts: [1, 1] },
    ]);
    expect(by.x1.answered).toBe(2);
    expect(by.g1.rows[0].units).toEqual([3, 3]);
    expect(by.g1.totalUnits).toBe(6);
    expect(by.g1.answered).toBe(3);
    expect(by.t1.answered).toBe(1);
  });

  it('withholds, on an anonymous form, the question below the floor and shows the one above', async () => {
    const out = await run(anonymousId, true);
    const by = Object.fromEntries(out.questions.map((q) => [q.id, q])) as any;
    expect(by.c1.suppressed).toBe(false);
    expect(by.c1.options[0].count).toBe(6);
    expect(by.s1.suppressed).toBe(true);
  });
});
