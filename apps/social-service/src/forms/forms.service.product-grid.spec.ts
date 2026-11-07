import { BadRequestException, HttpException, ValidationPipe } from '@nestjs/common';
import axios from 'axios';
import { FormsService } from './forms.service';
import { SubmitFormDto } from './dto/form.dto';
import type { ProductGrid } from './product-grid-contract';
import type { ProductGridRefusalBody } from './product-grid';
import type { PricingFacts } from '../pricing/audience';
import { PROVIDER_MAX_AMOUNT_CENTS } from '../common/core-payment-error';

/**
 * THE PRICED GRID THROUGH `FormsService` (WP-G1): what a save refuses and stores, what each page is
 * told, and what a submit CHARGES - computed from the stored grid and the payer's category, never
 * from anything the client sent - down to the one amount handed to Lydia.
 */

const COTISANT: PricingFacts = {
  promo: 2024,
  formation: null,
  cotisationTiers: [null],
  answers: {},
};
const NOBODY: PricingFacts = { promo: null, formation: null, cotisationTiers: [], answers: {} };

/** Hoodie: two colours x two sizes, Noir closed in XS, at most 3 per cell. */
const hoodie = (pricing: ProductGrid['pricing']): ProductGrid => ({
  rows: [
    { id: 'vert', label: 'Vert' },
    { id: 'noir', label: 'Noir' },
  ],
  columns: [
    { id: 'xs', label: 'XS' },
    { id: 'm', label: 'M' },
  ],
  maxPerCell: 3,
  closedCells: ['noir:xs'],
  pricing,
});
const COTISATION_TIERS = {
  id: 'cot',
  kind: 'cotisation' as const,
  buckets: [{ id: 'cotisant', label: 'Cotisant', anyTier: true }],
};
const SINGLE_TIERED = hoodie({
  mode: 'single',
  tiers: COTISATION_TIERS,
  prices: { cotisant: { '*': 2500 }, _others: { '*': 3000 } },
});

const gridItem = (productGrid: unknown = SINGLE_TIERED, over: Record<string, unknown> = {}) => ({
  id: 'q-grid',
  label: 'Sweat capuche',
  type: 'product_grid',
  required: true,
  productGrid,
  ...over,
});

const baseForm = (over: Record<string, unknown> = {}) => ({
  id: 'f1',
  ownerId: 'u-owner',
  associationId: 'a1',
  title: 'Merch',
  isPublic: false,
  anonymous: false,
  requiresPayment: true,
  currency: 'eur',
  basePrice: 0,
  allowMultipleSubmissions: true,
  allowCashPayment: false,
  maxSubmissions: null,
  opensAt: null,
  closedAt: null,
  priceMatrix: null,
  submitCondition: null,
  items: [gridItem()],
  ...over,
});

function makeService(opts: { form?: Record<string, unknown>; facts?: PricingFacts } = {}) {
  const saved: Record<string, unknown>[] = [];
  const manager: any = {
    query: jest.fn(() => Promise.resolve([])),
    findOne: jest.fn(() => Promise.resolve(null)),
    find: jest.fn(() => Promise.resolve([])),
    count: jest.fn(() => Promise.resolve(0)),
    create: jest.fn((_entity: unknown, row: Record<string, unknown>) => row),
    save: jest.fn((row: Record<string, unknown>) => {
      saved.push(row);
      return Promise.resolve({ id: 's1', ...row });
    }),
    update: jest.fn(() => Promise.resolve()),
  };
  const form = opts.form ?? baseForm();
  const formRepo: any = {
    findOne: jest.fn(() => Promise.resolve(form)),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
    create: jest.fn((x: unknown) => x),
    manager: { query: jest.fn(() => Promise.resolve([])) },
  };
  const submissionRepo: any = {
    count: jest.fn(() => Promise.resolve(0)),
    findOne: jest.fn(() => Promise.resolve(null)),
    find: jest.fn(() => Promise.resolve([])),
    update: jest.fn(() => Promise.resolve()),
    manager: { transaction: jest.fn((_l: string, fn: any) => fn(manager)) },
  };
  // As `PricingFactsService.build`: a guest (no account) holds no cotisation, no promo, no formation.
  const pricingFacts: any = {
    build: jest.fn((input: { userId?: string; answers: Record<string, string[]> }) =>
      Promise.resolve({
        ...(input.userId ? (opts.facts ?? NOBODY) : NOBODY),
        answers: input.answers ?? {},
      })
    ),
  };
  const userTagService: any = {
    listCotisationTiers: jest.fn(() => Promise.resolve([{ variantKey: null }])),
    cotisationModeOf: jest.fn(() => Promise.resolve('simple')),
  };
  const service = new FormsService(
    formRepo,
    submissionRepo,
    {} as any,
    { get: jest.fn(() => 'https://canari.example') } as any,
    {
      isMember: jest.fn(() => Promise.resolve(true)),
      collectsNow: jest.fn(() => Promise.resolve(true)),
      assertPaymentsReady: jest.fn(() => Promise.resolve()),
      getPaymentAccountId: jest.fn(() => Promise.resolve('vendor')),
      getActivePaymentProvider: jest.fn(() => Promise.resolve('lydia')),
      collectionSubjectOf: jest.fn(() => Promise.resolve(null)),
      mayAct: jest.fn(() => Promise.resolve(true)),
    } as any,
    userTagService,
    {} as any,
    pricingFacts,
    { count: jest.fn() } as any,
    {} as any,
    { enabled: () => false } as any,
    {} as any // FormItemImagesService
  );
  return { service, saved, manager, formRepo, submissionRepo, userTagService };
}

/** The 400's body: its code, read where a client reads it. */
async function refusalCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      return (error.getResponse() as { code?: string }).code;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

let post: jest.SpyInstance;
const savedSecret = process.env.INTERNAL_SECRET;
// A guest's paid answer is counted under an HMAC of the internal secret (`guest-visitor.ts`).
beforeAll(() => {
  process.env.INTERNAL_SECRET = 'internal-secret-for-spec';
});
afterAll(() => {
  if (savedSecret === undefined) delete process.env.INTERNAL_SECRET;
  else process.env.INTERNAL_SECRET = savedSecret;
});
beforeEach(() => {
  post = jest.spyOn(axios, 'post').mockResolvedValue({
    data: { url: 'https://lydia.example/pay', id: 'a'.repeat(32), requestId: '9001' },
  });
});
afterEach(() => jest.restoreAllMocks());

/** The one amount the last submit asked core-service to charge. */
const chargedCents = () => {
  const [, body] = post.mock.calls[post.mock.calls.length - 1] as [string, any];
  expect(body.lineItems).toHaveLength(1);
  expect(body.lineItems[0].quantity).toBe(1);
  return body.lineItems[0].price_data.unit_amount as number;
};

describe('FormsService - product grid: the save', () => {
  const createInput = (over: Record<string, unknown> = {}) =>
    ({
      title: 'Merch',
      basePrice: 0,
      currency: 'eur',
      requiresPayment: true,
      allowMultipleSubmissions: true,
      ownerId: 'u-owner',
      associationId: 'a1',
      items: [gridItem()],
      ...over,
    }) as any;

  it('stores the grid normalised: labels trimmed, unknown fields dropped, required kept', async () => {
    const { service } = makeService();
    const messy = {
      ...SINGLE_TIERED,
      rows: [
        { id: 'vert', label: '  Vert ', colour: '#0f0' },
        { id: 'noir', label: 'Noir' },
      ],
      stock: 12,
    };
    const form: any = await service.create(createInput({ items: [gridItem(messy)] }));
    const stored = form.items[0].productGrid;
    expect(stored.rows[0]).toEqual({ id: 'vert', label: 'Vert' });
    expect(stored).not.toHaveProperty('stock');
    expect(stored.pricing.tiers).toEqual(COTISATION_TIERS);
  });

  it('drops a grid definition carried by another question type', async () => {
    const { service } = makeService();
    const form: any = await service.create(
      createInput({
        items: [{ id: 'q1', label: 'Nom', type: 'short_text', required: true, productGrid: {} }],
      })
    );
    expect(form.items[0]).not.toHaveProperty('productGrid');
  });

  it('refuses each broken definition with its code', async () => {
    const { service } = makeService();
    expect(await refusalCode(service.create(createInput({ requiresPayment: false })))).toBe(
      'PRODUCT_GRID_REQUIRES_PAYMENT'
    );
    expect(
      await refusalCode(
        service.create(createInput({ items: [gridItem(SINGLE_TIERED, { required: false })] }))
      )
    ).toBe('PRODUCT_GRID_NOT_REQUIRED');
    expect(
      await refusalCode(
        service.create(
          createInput({
            items: [
              gridItem({
                ...SINGLE_TIERED,
                columns: [
                  { id: 'xs', label: 'M' },
                  { id: 'm', label: 'm' },
                ],
              }),
            ],
          })
        )
      )
    ).toBe('PRODUCT_GRID_DUPLICATE_LABEL');
  });

  it('judges the tier criterion against the association: an unknown cotisation tier is refused', async () => {
    const { service } = makeService();
    const unknownTier = {
      ...SINGLE_TIERED,
      pricing: {
        ...SINGLE_TIERED.pricing,
        tiers: {
          ...COTISATION_TIERS,
          buckets: [{ id: 'cotisant', label: 'C', variantKeys: ['gold'] }],
        },
      },
    };
    expect(await refusalCode(service.create(createInput({ items: [gridItem(unknownTier)] })))).toBe(
      'PRODUCT_GRID_TIER_INVALID'
    );
    // A personal form has no association to be a member of.
    expect(await refusalCode(service.create(createInput({ associationId: undefined })))).toBe(
      'PRODUCT_GRID_TIER_INVALID'
    );
  });

  it('names the refused question in the 400, so the editor draws it under its grid', async () => {
    const { service } = makeService();
    const unknownTier = {
      ...SINGLE_TIERED,
      pricing: {
        ...SINGLE_TIERED.pricing,
        tiers: {
          ...COTISATION_TIERS,
          buckets: [{ id: 'cotisant', label: 'C', variantKeys: ['gold'] }],
        },
      },
    };
    const refusal = await service
      .create(createInput({ items: [gridItem(unknownTier)] }))
      .then(() => null)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(BadRequestException);
    const body = (refusal as BadRequestException).getResponse() as ProductGridRefusalBody;
    expect(body).toEqual({
      code: 'PRODUCT_GRID_TIER_INVALID',
      message: expect.any(String),
      itemId: 'q-grid',
    });
    // A structural refusal names its question the same way.
    const missing = await service
      .create(createInput({ items: [gridItem(SINGLE_TIERED, { id: 'q-other', required: false })] }))
      .catch((error: unknown) => error);
    expect(((missing as BadRequestException).getResponse() as ProductGridRefusalBody).itemId).toBe(
      'q-other'
    );
  });

  it('a public form must price "everyone else", which every guest pays', async () => {
    const { service } = makeService();
    const noGuestPrice = {
      ...SINGLE_TIERED,
      pricing: { ...SINGLE_TIERED.pricing, prices: { cotisant: { '*': 2500 } } },
    };
    expect(
      await refusalCode(
        service.create(createInput({ isPublic: true, items: [gridItem(noGuestPrice)] }))
      )
    ).toBe('PRODUCT_GRID_GUEST_PRICE_MISSING');
  });

  it('an edit that only switches payment off is judged against the stored grid', async () => {
    const { service } = makeService();
    expect(
      await refusalCode(service.update('f1', { requiresPayment: false } as any, 'u-owner', false))
    ).toBe('PRODUCT_GRID_REQUIRES_PAYMENT');
  });
});

describe('FormsService - product grid: what a page is told', () => {
  it('a member is told the prices of THEIR category only', async () => {
    const { service } = makeService({ facts: COTISANT });
    const check = await service.hasSubmission('f1', 'u1');
    expect(check.productGridPrices).toEqual({
      'q-grid': { tierId: 'cotisant', tierLabel: 'Cotisant', prices: { '*': 2500 } },
    });
  });

  it('a guest reads the grid without its price lists, and the "everyone else" prices', async () => {
    const { service } = makeService({ form: baseForm({ isPublic: true }) });
    const view: any = await service.getPublic('f1');
    expect(view.items[0].productGrid.pricing).toEqual({ mode: 'single' });
    expect(view.items[0].productGrid.closedCells).toEqual(['noir:xs']);
    expect(JSON.stringify(view.items)).not.toContain('2500');
    expect(view.productGridPrices['q-grid']).toEqual({
      tierId: '_others',
      tierLabel: null,
      prices: { '*': 3000 },
    });
  });
});

describe('FormsService - product grid: what a submit charges', () => {
  const submit = (service: FormsService, answers: Record<string, unknown>, extra = {}) =>
    service.submit('f1', { userId: 'u1', answers, ...extra } as any);

  it('a cotisant pays the cotisant price per unit, and Lydia is asked for exactly the sum', async () => {
    const { service, saved } = makeService({ facts: COTISANT });
    await submit(service, { 'q-grid': { 'vert:m': 2, 'noir:m': 1 } });
    expect(chargedCents()).toBe(3 * 2500);
    expect(saved[0].totalPaid).toBe(7500);
    expect(saved[0].answers).toEqual({ 'q-grid': { 'vert:m': 2, 'noir:m': 1 } });
    expect(saved[0].lines).toEqual([
      expect.objectContaining({
        rowLabel: 'Vert',
        colLabel: 'M',
        quantity: 2,
        unitCents: 2500,
        lineCents: 5000,
        tierId: 'cotisant',
        tierLabel: 'Cotisant',
      }),
      expect.objectContaining({
        rowLabel: 'Noir',
        colLabel: 'M',
        quantity: 1,
        unitCents: 2500,
        lineCents: 2500,
      }),
    ]);
  });

  it('a member in no category pays "everyone else"', async () => {
    const { service } = makeService({ facts: NOBODY });
    await submit(service, { 'q-grid': { 'vert:xs': 1 } });
    expect(chargedCents()).toBe(3000);
  });

  it('a guest pays "everyone else"', async () => {
    const { service, saved } = makeService({ form: baseForm({ isPublic: true }), facts: COTISANT });
    await service.submit(
      'f1',
      { answers: { 'q-grid': { 'vert:m': 1 } } } as any,
      'guest',
      '198.51.100.7'
    );
    expect(chargedCents()).toBe(3000);
    expect(saved[0].userId).toBeNull();
    expect((saved[0].lines as any[])[0].tierId).toBe('_others');
  });

  it('per_row and per_column read the row, or the column, price; with a promo tier', async () => {
    const promo = {
      id: 'p',
      kind: 'promo' as const,
      buckets: [{ id: 'p24', label: '1A', values: [2024] }],
    };
    const perRow = hoodie({
      mode: 'per_row',
      tiers: promo,
      prices: { p24: { vert: 2000, noir: 2200 }, _others: { vert: 2600, noir: 2800 } },
    });
    const a = makeService({ form: baseForm({ items: [gridItem(perRow)] }), facts: COTISANT });
    await submit(a.service, { 'q-grid': { 'vert:m': 1, 'noir:m': 2 } });
    expect(chargedCents()).toBe(2000 + 2 * 2200);

    const perColumn = hoodie({
      mode: 'per_column',
      tiers: null,
      prices: { _all: { xs: 2500, m: 2800 } },
    });
    const b = makeService({ form: baseForm({ items: [gridItem(perColumn)] }) });
    await submit(b.service, { 'q-grid': { 'vert:xs': 3, 'vert:m': 1 } });
    expect(chargedCents()).toBe(3 * 2500 + 2800);
  });

  it('adds to the base price and to a choice supplement', async () => {
    const supplement = {
      id: 'q-livr',
      label: 'Livraison',
      type: 'single_choice',
      required: true,
      options: [{ id: 'o-oui', label: 'Oui', priceModifier: 400 }],
    };
    const { service } = makeService({
      form: baseForm({ basePrice: 100, items: [gridItem(), supplement] }),
    });
    await submit(service, { 'q-grid': { 'vert:m': 1 }, 'q-livr': 'o-oui' });
    expect(chargedCents()).toBe(100 + 3000 + 400);
  });

  it('never reads an amount from the client', async () => {
    const { service, saved } = makeService({ facts: COTISANT });
    await submit(
      service,
      { 'q-grid': { 'vert:m': 1 } },
      {
        totalPaid: 1,
        amount: 1,
        lines: [{ unitCents: 1 }],
        productGridPrices: { 'q-grid': { prices: { '*': 1 } } },
      }
    );
    expect(chargedCents()).toBe(2500);
    expect(saved[0].totalPaid).toBe(2500);
  });

  it('refuses a forged answer, coded, before any row is written', async () => {
    const { service, saved } = makeService();
    const cases: [unknown, string][] = [
      [undefined, 'PRODUCT_GRID_ANSWER_MISSING'],
      ['', 'PRODUCT_GRID_ANSWER_MISSING'],
      [{ 'rose:m': 1 }, 'PRODUCT_GRID_UNKNOWN_CELL'],
      [{ 'vert:m': 4 }, 'PRODUCT_GRID_QUANTITY_INVALID'],
      [{ 'vert:m': 1.5 }, 'PRODUCT_GRID_QUANTITY_INVALID'],
      [{ 'vert:m': -2, 'noir:m': 3 }, 'PRODUCT_GRID_QUANTITY_INVALID'],
      [{ 'noir:xs': 1 }, 'PRODUCT_GRID_CELL_CLOSED'],
      [{}, 'PRODUCT_GRID_EMPTY'],
      [{ 'vert:m': 0 }, 'PRODUCT_GRID_EMPTY'],
    ];
    for (const [answer, code] of cases) {
      expect(await refusalCode(submit(service, { 'q-grid': answer }))).toBe(code);
    }
    expect(saved).toHaveLength(0);
    expect(post).not.toHaveBeenCalled();
  });

  it('a grid the person does not see is neither required nor charged nor stored', async () => {
    const hidden = gridItem(SINGLE_TIERED, { showIf: { promo: { values: [2020] } } });
    const name = { id: 'q1', label: 'Nom', type: 'short_text', required: true };
    const { service, saved } = makeService({
      form: baseForm({ items: [name, hidden] }),
      facts: COTISANT,
    });
    await submit(service, { q1: 'Ada', 'q-grid': { 'vert:m': 1 } });
    expect(saved[0].answers).toEqual({ q1: 'Ada' });
    expect(saved[0].lines).toBeNull();
    expect(saved[0].paymentStatus).toBe('free');
  });

  it('a cash order keeps its lines and goes to pending_cash, at the same total', async () => {
    const { service, saved, submissionRepo } = makeService({
      form: baseForm({ allowCashPayment: true, cashPaymentExpiryDays: 3 }),
    });
    const result: any = await submit(
      service,
      { 'q-grid': { 'vert:m': 2 } },
      { paymentMethod: 'cash' }
    );
    expect(result.cashPayment).toBe(true);
    expect(saved[0].totalPaid).toBe(6000);
    expect((saved[0].lines as any[])[0].quantity).toBe(2);
    expect(submissionRepo.update).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ paymentStatus: 'pending_cash' })
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('a total above the payable maximum is refused before any row is written, cash included', async () => {
    // Three units at 40 % of the maximum each: one unit is payable, three are not.
    const unit = Math.ceil(PROVIDER_MAX_AMOUNT_CENTS * 0.4);
    const dear = hoodie({ mode: 'single', tiers: null, prices: { _all: { '*': unit } } });
    const { service, saved } = makeService({
      form: baseForm({ items: [gridItem(dear)], allowCashPayment: true }),
    });
    expect(
      await refusalCode(submit(service, { 'q-grid': { 'vert:m': 3 } }, { paymentMethod: 'cash' }))
    ).toBe('AMOUNT_OUT_OF_RANGE');
    expect(saved).toHaveLength(0);
  });
});

describe('SubmitFormDto - a grid answer through the real ValidationPipe', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const run = (answers: unknown) =>
    pipe.transform({ answers }, { type: 'body', metatype: SubmitFormDto });

  it('accepts an object answer of quantities', async () => {
    const dto = await run({ 'q-grid': { 'vert:m': 2 }, q1: 'Ada' });
    expect(dto.answers['q-grid']).toEqual({ 'vert:m': 2 });
  });

  it('refuses an object nested deeper, or one over the bound', async () => {
    await expect(run({ 'q-grid': { 'vert:m': { deep: 1 } } })).rejects.toThrow(BadRequestException);
    const huge = Object.fromEntries(Array.from({ length: 601 }, (_, i) => [`r${i}:c`, 1]));
    await expect(run({ 'q-grid': huge })).rejects.toThrow(BadRequestException);
  });
});
