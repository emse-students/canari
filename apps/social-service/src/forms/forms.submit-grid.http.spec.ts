import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { createHmac } from 'crypto';
import type { AddressInfo } from 'net';
import { AssociationsService } from '../associations/associations.service';
import { PricingFactsService } from '../pricing/pricing-facts.service';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { UserTagService } from '../users/user-tag.service';
import {
  ANSWER_MAX_TEXT_LENGTH,
  FORM_ANSWER_MISSING,
  FORM_GRID_ANSWER_INVALID,
} from './answer-bounds';
import { FormFilesService } from './form-files.service';
import { FormsController } from './forms.controller';
import { FormsService } from './forms.service';
import { PublicFormsController } from './public-forms.controller';

/**
 * A GRID ANSWER, SENT OVER HTTP THROUGH THE REAL `ValidationPipe` AND THE REAL CONTROLLERS.
 *
 * The gap that hid D1 (forms audit, 2026-11-06): every grid test called `FormsService.submit`
 * directly, so nothing ever sent a grid answer through the DTO validator, which refused it - every
 * form holding a visible grid was unsubmittable from 2026-06-01 on, member and guest alike. This
 * boots a Nest application with the global pipe configured as `main.ts` configures it, the member
 * and the guest controllers, and the real `FormsService` over mocked repositories, and submits.
 */

const FORM_ID = '0b6f2f8e-5d3c-4a8e-9a51-7c2f1b0d9e11';
const USER_ID = 'user-grid-1';
const SECRET = 'grid-spec-secret';

const GRID_SINGLE = {
  id: 'q_size',
  label: 'Taille par couleur',
  type: 'matrix_single',
  required: true,
  rows: ['Vert', 'Noir'],
  options: [
    { id: 'col_s', label: 'S', priceModifier: 0 },
    { id: 'col_m', label: 'M', priceModifier: 0 },
  ],
};

const GRID_MULTIPLE = {
  id: 'q_days',
  label: 'Disponibilites',
  type: 'matrix_multiple',
  required: false,
  rows: ['Lundi', 'Mardi'],
  options: [
    { id: 'col_am', label: 'Matin', priceModifier: 0 },
    { id: 'col_pm', label: 'Apres-midi', priceModifier: 0 },
  ],
};

const LONG_TEXT = { id: 'q_letter', label: 'Lettre', type: 'long_text', required: false };

function makeForm() {
  return {
    id: FORM_ID,
    title: 'Sweat',
    currency: 'eur',
    basePrice: 0,
    items: [GRID_SINGLE, GRID_MULTIPLE, LONG_TEXT],
    allowMultipleSubmissions: true,
    isPublic: true,
    anonymous: false,
    associationId: null,
    ownerId: 'owner-1',
    priceMatrix: null,
  };
}

/** The real service over mocked repositories, the shape `forms.service.matrix.spec.ts` builds. */
function makeService(saved: Record<string, unknown>[]) {
  const manager = {
    query: jest.fn(() => Promise.resolve([])),
    count: jest.fn(() => Promise.resolve(0)),
    findOne: jest.fn(() => Promise.resolve(null)),
    find: jest.fn(() => Promise.resolve([])),
    create: jest.fn((_entity: unknown, x: Record<string, unknown>) => x),
    save: jest.fn((x: Record<string, unknown>) => {
      saved.push(x);
      return Promise.resolve({ ...x, id: 's1' });
    }),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const submissionRepo: any = {
    count: jest.fn(() => Promise.resolve(0)),
    findOne: jest.fn(() => Promise.resolve(null)),
    find: jest.fn(() => Promise.resolve([])),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    manager: {
      transaction: jest.fn((_level: string, run: (m: unknown) => Promise<void>) => run(manager)),
    },
  };
  const pricingFacts: any = {
    build: jest.fn((input: { answers?: Record<string, string[]> }) =>
      Promise.resolve({
        promo: null,
        formation: null,
        cotisationTiers: [],
        answers: input.answers ?? {},
      })
    ),
  };
  return new FormsService(
    { findOne: jest.fn(() => Promise.resolve(makeForm())) } as any,
    submissionRepo,
    { findOne: jest.fn(), save: jest.fn() } as any,
    { get: jest.fn() } as any,
    { isMember: jest.fn(), assertPaymentsReady: jest.fn(), callerHasFlag: jest.fn() } as any,
    { listCotisationTiers: jest.fn(() => Promise.resolve([])) } as any,
    { create: jest.fn() } as any,
    pricingFacts,
    {} as any,
    {} as any,
    { enabled: () => false } as any
  );
}

describe('a grid answer over HTTP, through the real ValidationPipe (D1)', () => {
  let app: INestApplication;
  let base: string;
  const saved: Record<string, unknown>[] = [];
  const previousSecret = process.env.INTERNAL_SHARED_SECRET;

  beforeAll(async () => {
    process.env.INTERNAL_SHARED_SECRET = SECRET;
    const service = makeService(saved);
    @Module({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [FormsController, PublicFormsController],
      providers: [
        { provide: FormsService, useValue: service },
        { provide: AssociationsService, useValue: {} },
        { provide: PurchaseRecordService, useValue: {} },
        { provide: UserTagService, useValue: {} },
        { provide: PricingFactsService, useValue: {} },
        { provide: FormFilesService, useValue: {} },
      ],
    })
    class GridHttpModule {}
    app = await NestFactory.create(GridHttpModule, { logger: false });
    app.setGlobalPrefix('api');
    // As `main.ts` configures it: the pipe that refused every grid answer.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}/api`;
  });

  afterAll(async () => {
    await app?.close();
    process.env.INTERNAL_SHARED_SECRET = previousSecret;
  });

  beforeEach(() => {
    saved.length = 0;
  });

  /** The headers nginx sets for a signed-in member: the id and its per-minute HMAC. */
  function memberHeaders(): Record<string, string> {
    const minute = Math.floor(Date.now() / 60000);
    return {
      'content-type': 'application/json',
      'x-user-id': USER_ID,
      'x-internal-token': createHmac('sha256', SECRET).update(`${USER_ID}:${minute}`).digest('hex'),
    };
  }

  const memberSubmit = (answers: unknown) =>
    fetch(`${base}/forms/${FORM_ID}/submit`, {
      method: 'POST',
      headers: memberHeaders(),
      body: JSON.stringify({ answers }),
    });

  const guestSubmit = (answers: unknown) =>
    fetch(`${base}/public/forms/${FORM_ID}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.7' },
      body: JSON.stringify({ answers }),
    });

  it('stores a member answer holding both grids', async () => {
    const res = await memberSubmit({
      q_size: { Vert: 'col_m', Noir: '' },
      q_days: { Lundi: ['col_am', 'col_pm'] },
    });
    expect(res.status).toBe(201);
    expect(saved).toHaveLength(1);
    // The empty row an older page sends is dropped; the answered rows are kept as sent.
    expect(saved[0].answers).toEqual({
      q_size: { Vert: 'col_m' },
      q_days: { Lundi: ['col_am', 'col_pm'] },
    });
    expect(saved[0].userId).toBe(USER_ID);
  });

  it('stores a guest answer holding a grid', async () => {
    const res = await guestSubmit({ q_size: { Noir: 'col_s' } });
    expect(res.status).toBe(200);
    expect(saved).toHaveLength(1);
    expect(saved[0].answers).toEqual({ q_size: { Noir: 'col_s' } });
    expect(saved[0].userId).toBeNull();
  });

  it('refuses a required grid with no answered row, with a typed code naming it', async () => {
    const res = await memberSubmit({ q_size: { Vert: '', Noir: '' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe(FORM_ANSWER_MISSING);
    expect(body.itemId).toBe('q_size');
    expect(saved).toHaveLength(0);
  });

  it('refuses a grid answer naming an undeclared column, member and guest alike', async () => {
    for (const send of [memberSubmit, guestSubmit]) {
      const res = await send({ q_size: { Vert: 'col_xl' } });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe(FORM_GRID_ANSWER_INVALID);
    }
    expect(saved).toHaveLength(0);
  });

  it('still refuses a nested object one level too deep at the pipe', async () => {
    const res = await memberSubmit({ q_size: { Vert: { deeper: 'col_m' } } });
    expect(res.status).toBe(400);
    expect(saved).toHaveLength(0);
  });

  it('takes a long text at the bound and refuses one past it at the pipe', async () => {
    const atBound = await memberSubmit({
      q_size: { Vert: 'col_s' },
      q_letter: 'a'.repeat(ANSWER_MAX_TEXT_LENGTH),
    });
    expect(atBound.status).toBe(201);
    const past = await memberSubmit({
      q_size: { Vert: 'col_s' },
      q_letter: 'a'.repeat(ANSWER_MAX_TEXT_LENGTH + 1),
    });
    expect(past.status).toBe(400);
  });
});
