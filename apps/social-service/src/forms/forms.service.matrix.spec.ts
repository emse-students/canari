import { FormsService } from './forms.service';
import { OTHERS_BUCKET_ID } from './pricing/audience';

/**
 * The price actually charged, end to end through `submit`.
 *
 * The unit tests next door prove the matrix resolves correctly; these prove the service charges what
 * it resolved, refuses what it cannot resolve, and stopped doing two things it used to do wrong on
 * hidden questions. Every case takes the cash path, which returns before Stripe - the figure under
 * test is `totalPaid` on the stored submission, which is also the amount Stripe would be asked for.
 */
describe('FormsService pricing, through submit', () => {
  const MENU_QUESTION = {
    id: 'q_menu',
    label: 'Menu',
    required: false,
    type: 'single_choice',
    options: [
      { id: 'opt_veg', label: 'Vegetarien', priceModifier: 500 },
      { id: 'opt_meat', label: 'Viande', priceModifier: 900 },
    ],
  };

  /** Cotisant x menu: the user's own example, a BDE cotisation priced by menu and membership. */
  const MATRIX = {
    dimensions: [
      { id: 'cot', kind: 'cotisation', buckets: [{ id: 'yes', label: 'Cotisant', anyTier: true }] },
      {
        id: 'menu',
        kind: 'answer',
        questionId: 'q_menu',
        buckets: [
          { id: 'veg', label: 'Vegetarien', values: ['opt_veg'] },
          { id: 'meat', label: 'Viande', values: ['opt_meat'] },
        ],
      },
    ],
    cells: {
      'yes|veg': 1000,
      'yes|meat': 1200,
      [`yes|${OTHERS_BUCKET_ID}`]: 800,
      [`${OTHERS_BUCKET_ID}|veg`]: 2000,
      [`${OTHERS_BUCKET_ID}|meat`]: 2200,
      [`${OTHERS_BUCKET_ID}|${OTHERS_BUCKET_ID}`]: 1800,
    },
  };

  function makeService(
    opts: {
      form?: Record<string, unknown>;
      /** Facts the profile service answers with; a thrown value simulates core-service down. */
      facts?: Record<string, unknown>;
      factsError?: Error;
    } = {}
  ) {
    const saved: Record<string, unknown>[] = [];
    const manager = {
      count: jest.fn(() => Promise.resolve(0)),
      findOne: jest.fn(() => Promise.resolve(null)),
      create: jest.fn((_entity: unknown, x: Record<string, unknown>) => x),
      save: jest.fn((x: Record<string, unknown>) => {
        saved.push(x);
        return Promise.resolve({ ...x, id: 's1' });
      }),
    };
    const submissionRepo: any = {
      count: jest.fn(() => Promise.resolve(0)),
      findOne: jest.fn(() => Promise.resolve(null)),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      manager: {
        transaction: jest.fn((_level: string, run: (m: unknown) => Promise<void>) => run(manager)),
      },
    };
    const submitterFacts: any = {
      build: jest.fn((input: { answers?: Record<string, string[]> }) => {
        if (opts.factsError) return Promise.reject(opts.factsError);
        return Promise.resolve({
          promo: null,
          formation: null,
          cotisationTiers: [],
          answers: input.answers ?? {},
          ...opts.facts,
        });
      }),
    };
    const service = new FormsService(
      {
        findOne: jest.fn(() => Promise.resolve(opts.form ?? null)),
        create: jest.fn((x: unknown) => x),
        save: jest.fn((x: unknown) => Promise.resolve(x)),
      } as any,
      submissionRepo,
      { findOne: jest.fn(), save: jest.fn() } as any,
      { get: jest.fn() } as any,
      { isMember: jest.fn(), assertPaymentsReady: jest.fn(), callerHasFlag: jest.fn() } as any,
      { listCotisationTiers: jest.fn(() => Promise.resolve([])) } as any,
      { create: jest.fn() } as any,
      submitterFacts
    );
    return { service, submitterFacts, saved };
  }

  const form = (over: Record<string, unknown> = {}) => ({
    id: 'f1',
    title: 'Cotisation BDE',
    currency: 'eur',
    basePrice: 0,
    items: [MENU_QUESTION],
    allowCashPayment: true,
    allowMultipleSubmissions: true,
    associationId: 'asso1',
    priceMatrix: MATRIX,
    ...over,
  });

  const submit = (service: FormsService, answers: Record<string, unknown>, userId = 'user1') =>
    service.submit('f1', { userId, answers, paymentMethod: 'cash' } as any);

  describe('the cell decides the price', () => {
    it('charges the cotisant cell for a cotisant', async () => {
      const { service, saved } = makeService({
        form: form(),
        facts: { cotisationTiers: [null] },
      });
      await submit(service, { q_menu: 'opt_meat' });
      expect(saved[0].totalPaid).toBe(1200);
    });

    it('charges the public cell for a non-cotisant, same answer', async () => {
      const { service, saved } = makeService({ form: form() });
      await submit(service, { q_menu: 'opt_meat' });
      expect(saved[0].totalPaid).toBe(2200);
    });

    // The whole reason a matrix beats two prices: the two criteria interact, they do not add up.
    it('charges the unanswered cell when the priced question is skipped', async () => {
      const { service, saved } = makeService({ form: form(), facts: { cotisationTiers: [null] } });
      await submit(service, {});
      expect(saved[0].totalPaid).toBe(800);
    });

    // A form with no grid is every form that exists today, and none of them may change price.
    it('charges basePrice when there is no grid at all', async () => {
      const { service, saved } = makeService({
        form: form({ priceMatrix: null, basePrice: 1500 }),
      });
      await submit(service, {});
      expect(saved[0].totalPaid).toBe(1500);
    });
  });

  /**
   * The double count. `q_menu` carries `priceModifier` 900 from before it became a criterion, and
   * the cell already prices the choice - so adding the modifier would charge the same menu twice,
   * silently, in the direction that overcharges a student.
   */
  describe('a question the grid prices on adds no modifier', () => {
    it('charges the cell alone, not the cell plus the modifier', async () => {
      const { service, saved } = makeService({ form: form() });
      await submit(service, { q_menu: 'opt_meat' });
      expect(saved[0].totalPaid).toBe(2200);
      expect(saved[0].totalPaid).not.toBe(2200 + 900);
    });

    it('still adds the modifier of a question the grid does NOT price on', async () => {
      const tshirt = {
        id: 'q_tshirt',
        label: 'T-shirt',
        required: false,
        type: 'single_choice',
        options: [{ id: 'opt_m', label: 'M', priceModifier: 700 }],
      };
      const { service, saved } = makeService({
        form: form({ items: [MENU_QUESTION, tshirt] }),
      });
      await submit(service, { q_menu: 'opt_veg', q_tshirt: 'opt_m' });
      expect(saved[0].totalPaid).toBe(2000 + 700);
    });
  });

  /**
   * Both of these were live defects, and both existed because `dependsOn` had only ever been
   * evaluated in the browser.
   */
  describe('a hidden question neither blocks nor charges', () => {
    const conditional = {
      id: 'q_extra',
      label: 'Extra',
      required: true,
      type: 'single_choice',
      dependsOn: 'q_menu',
      dependsValue: 'opt_veg',
      options: [{ id: 'opt_extra', label: 'Extra', priceModifier: 300 }],
    };

    it('does not demand a required question the submitter never saw', async () => {
      const { service, saved } = makeService({
        form: form({ items: [MENU_QUESTION, conditional] }),
      });
      // Menu is "meat", so the conditional question is not shown and not answered. Before this, the
      // server threw "Missing required field" and the form could not be submitted at all.
      await expect(submit(service, { q_menu: 'opt_meat' })).resolves.toBeDefined();
      expect(saved[0].totalPaid).toBe(2200);
    });

    it('ignores an answer sent for a question that was not shown', async () => {
      const { service, saved } = makeService({
        form: form({ items: [MENU_QUESTION, conditional] }),
      });
      await submit(service, { q_menu: 'opt_meat', q_extra: 'opt_extra' });
      expect(saved[0].totalPaid).toBe(2200);
    });

    it('does demand it, and does charge it, when the condition holds', async () => {
      const { service, saved } = makeService({
        form: form({ items: [MENU_QUESTION, conditional] }),
      });
      await expect(submit(service, { q_menu: 'opt_veg' })).rejects.toThrow(
        /Missing required field/
      );
      await submit(service, { q_menu: 'opt_veg', q_extra: 'opt_extra' });
      expect(saved[0].totalPaid).toBe(2000 + 300);
    });
  });

  describe('who may submit', () => {
    it('refuses a submitter the form is not open to', async () => {
      const { service } = makeService({
        form: form({ submitCondition: { formation: { values: ['ICM'] } } }),
        facts: { formation: 'ISMIN' },
      });
      await expect(submit(service, {})).rejects.toThrow(/not open to you/i);
    });

    it('accepts one it is', async () => {
      const { service, saved } = makeService({
        form: form({ submitCondition: { formation: { values: ['ICM'] } } }),
        facts: { formation: 'ICM' },
      });
      await submit(service, {});
      expect(saved).toHaveLength(1);
    });
  });

  /**
   * A cell can be marked as NOT EXISTING - "non-cotisant, menu viande" is a combination the
   * association simply does not sell. That is a refusal no price can carry, since 0 means free.
   *
   * It is refused after the price is resolved rather than in `assertMaySubmit`, because only the
   * VISIBLE answers decide which cell applies: a condition checked before visibility would be
   * checking a cell the submitter is not in.
   */
  describe('a combination marked as not existing', () => {
    /** Same grid, with the public meat cell closed. */
    const closed = () => ({
      ...MATRIX,
      cells: { ...MATRIX.cells, [`${OTHERS_BUCKET_ID}|meat`]: null },
    });

    it('refuses the submission instead of charging zero', async () => {
      const { service, saved } = makeService({ form: form({ priceMatrix: closed() }) });
      await expect(submit(service, { q_menu: 'opt_meat' })).rejects.toThrow(/not available/i);
      expect(saved).toHaveLength(0);
    });

    // The refusal is per-CELL, not per-form: the same person answering differently is priced.
    it('still accepts every combination that does exist', async () => {
      const { service, saved } = makeService({ form: form({ priceMatrix: closed() }) });
      await submit(service, { q_menu: 'opt_veg' });
      expect(saved[0].totalPaid).toBe(2000);
    });

    // A cotisant is in another row entirely and must not be caught by it.
    it('leaves the other profile row alone', async () => {
      const { service, saved } = makeService({
        form: form({ priceMatrix: closed() }),
        facts: { cotisationTiers: [null] },
      });
      await submit(service, { q_menu: 'opt_meat' });
      expect(saved[0].totalPaid).toBe(1200);
    });

    // The quote carries the null, so the fill page can grey the option out rather than offer a
    // choice the submit above is going to refuse.
    it('quotes it as unavailable rather than as a price', async () => {
      const { service } = makeService({ form: form({ priceMatrix: closed() }) });
      const check = await service.hasSubmission('f1', 'user1');
      expect(check.pricing?.cells.meat).toBeNull();
      expect(check.pricing?.cells.veg).toBe(2000);
      expect(check.maySubmit).toBe(true);
    });

    /**
     * Their whole row closed: no answer they could give leads to a cell that exists. That is the
     * same outcome as an audience refusal - the form is not open to them - and reporting it as a
     * form with no price would show them a total of zero and a working submit button.
     */
    it('reports maySubmit false when their whole row is closed', async () => {
      const allClosed = {
        ...MATRIX,
        cells: Object.fromEntries(
          Object.keys(MATRIX.cells).map((key) => [
            key,
            key.startsWith(OTHERS_BUCKET_ID) ? null : MATRIX.cells[key],
          ])
        ),
      };
      const { service } = makeService({ form: form({ priceMatrix: allClosed }) });
      const check = await service.hasSubmission('f1', 'user1');
      expect(check.maySubmit).toBe(false);
    });
  });

  /**
   * Fail closed. Both silent alternatives are wrong and neither would be noticed: the "everyone
   * else" cell overcharges a student who qualified, a guessed bucket undercharges the association.
   */
  describe('when the profile cannot be read', () => {
    it('refuses the submission rather than pricing it wrongly', async () => {
      const { service } = makeService({
        form: form(),
        factsError: new Error('core-service unreachable'),
      });
      await expect(submit(service, {})).rejects.toThrow(/core-service unreachable/);
    });
  });

  /** A quote and a charge must be the same number, computed by the same call. */
  describe('the quote matches the charge', () => {
    it('offers the same cell price /check as submit charges', async () => {
      const { service, saved } = makeService({ form: form(), facts: { cotisationTiers: [null] } });
      const check = await service.hasSubmission('f1', 'user1');
      expect(check.pricing?.cells.meat).toBe(1200);
      await submit(service, { q_menu: 'opt_meat' });
      expect(saved[0].totalPaid).toBe(check.pricing?.cells.meat);
    });

    it('names the buckets that applied, so the page can say why', async () => {
      const { service } = makeService({ form: form(), facts: { cotisationTiers: [null] } });
      const check = await service.hasSubmission('f1', 'user1');
      expect(check.pricing?.appliedLabels).toEqual(['Cotisant']);
    });

    // The page must never be handed a price it is not entitled to.
    it('does not include the cotisant column in a non-cotisant quote', async () => {
      const { service } = makeService({ form: form() });
      const check = await service.hasSubmission('f1', 'user1');
      expect(Object.values(check.pricing?.cells ?? {})).toEqual([2000, 2200, 1800]);
    });

    it('reports a question hidden by a profile criterion', async () => {
      const gated = {
        id: 'q_icm',
        label: 'ICM only',
        required: false,
        type: 'text',
        showIf: { formation: { values: ['ICM'] } },
      };
      const { service } = makeService({
        form: form({ items: [MENU_QUESTION, gated] }),
        facts: { formation: 'ISMIN' },
      });
      const check = await service.hasSubmission('f1', 'user1');
      expect(check.hiddenItemIds).toEqual(['q_icm']);
    });
  });

  /** A form asking nothing of the identity provider must not be able to be blocked by it. */
  describe('core-service is only asked when a criterion needs it', () => {
    it('asks for no profile when the grid uses cotisation and answers only', async () => {
      const { service, submitterFacts } = makeService({ form: form() });
      await submit(service, {});
      expect(submitterFacts.build).toHaveBeenCalledWith(
        expect.objectContaining({ needProfile: false })
      );
    });

    it('asks for the profile when a criterion is a formation', async () => {
      const { service, submitterFacts } = makeService({
        form: form({
          priceMatrix: {
            dimensions: [
              {
                id: 'f',
                kind: 'formation',
                buckets: [{ id: 'icm', label: 'ICM', values: ['ICM'] }],
              },
            ],
            cells: { icm: 1000, [OTHERS_BUCKET_ID]: 2000 },
          },
        }),
      });
      await submit(service, {});
      expect(submitterFacts.build).toHaveBeenCalledWith(
        expect.objectContaining({ needProfile: true })
      );
    });

    it('asks for the profile when a QUESTION is gated on one', async () => {
      const { service, submitterFacts } = makeService({
        form: form({
          priceMatrix: null,
          items: [
            {
              id: 'q',
              label: 'q',
              required: false,
              type: 'text',
              showIf: { promo: { values: [2028] } },
            },
          ],
        }),
      });
      await submit(service, {});
      expect(submitterFacts.build).toHaveBeenCalledWith(
        expect.objectContaining({ needProfile: true })
      );
    });
  });
});
