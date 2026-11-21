import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { PRICING_CORE_BEHIND, PricingFactsService } from './pricing-facts.service';
import { NO_CURSUS } from './audience';
import type { UserTagService } from '../users/user-tag.service';

/**
 * How social-service reads a person's cursus views from core-service (D32): the list core-service
 * reconciled is taken as is, an empty one is `NO_CURSUS`, a 404 is an answer, and a 200 WITHOUT
 * `cursusViews` (a core-service older than D32 - a rollback window) is the typed 503
 * `PRICING_CORE_BEHIND`, never a price on nothing.
 */
describe('PricingFactsService - the cursus views read from core-service', () => {
  const USER = '00000000-0000-4000-8000-0000000000aa';
  const realFetch = global.fetch;
  let service: PricingFactsService;

  function answer(status: number, body: unknown): void {
    global.fetch = jest.fn(() =>
      Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body })
    ) as unknown as typeof fetch;
  }

  beforeEach(() => {
    service = new PricingFactsService({} as UserTagService);
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('takes every view core-service serves, in order', async () => {
    answer(200, {
      id: USER,
      cursusViews: [
        { promo: 2021, formation: 'ICM' },
        { promo: 2024, formation: 'ISMIN' },
      ],
    });
    await expect(service.cursusFor(USER, true)).resolves.toEqual([
      { promo: 2021, formation: 'ICM' },
      { promo: 2024, formation: 'ISMIN' },
    ]);
  });

  it('reads an empty list, and a 404, as NO_CURSUS', async () => {
    answer(200, { id: USER, cursusViews: [] });
    await expect(service.cursusFor(USER, true)).resolves.toBe(NO_CURSUS);
    answer(404, {});
    await expect(service.cursusFor(USER, true)).resolves.toBe(NO_CURSUS);
  });

  it('refuses with the typed PRICING_CORE_BEHIND when core-service serves no cursusViews', async () => {
    // What a core-service from before D32 answers: the raw `cursus` and the legacy columns only.
    answer(200, { id: USER, promo: 2021, formation: 'ICM', cursus: [] });
    const refusal = await service.cursusFor(USER, true).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ServiceUnavailableException);
    expect((refusal as ServiceUnavailableException).getResponse()).toMatchObject({
      code: PRICING_CORE_BEHIND,
    });
  });

  it('never calls core-service when the criteria need no profile', async () => {
    answer(500, {});
    await expect(service.cursusFor(USER, false)).resolves.toBe(NO_CURSUS);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('PricingFactsService - the account read of an anonymous form names nobody', () => {
  const USER = '00000000-0000-4000-8000-0000000000bb';
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('logs no user id on any outcome when the context is anonymous, and one when it is not', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'debug', 'warn', 'error', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    }
    const service = new PricingFactsService({} as UserTagService);
    const answers: Array<() => Promise<unknown>> = [
      () => Promise.reject(new Error('down')),
      () =>
        Promise.resolve({
          status: 404,
          ok: false,
          json: async () => ({ code: 'RESPONDENT_UNKNOWN' }),
        }),
      () => Promise.resolve({ status: 404, ok: false, json: async () => ({}) }),
      () => Promise.resolve({ status: 500, ok: false, json: async () => ({}) }),
    ];
    for (const answer of answers) {
      global.fetch = jest.fn(answer) as unknown as typeof fetch;
      await service.accountIdentity(USER, { anonymous: true }).catch(() => undefined);
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((l) => l.includes(USER.slice(0, 8)))).toEqual([]);
    lines.length = 0;
    // The profile read that prices an audience criterion takes the same context.
    for (const answer of [answers[0], answers[1], answers[3]]) {
      global.fetch = jest.fn(answer) as unknown as typeof fetch;
      await service.cursusFor(USER, true, { anonymous: true }).catch(() => undefined);
    }
    global.fetch = jest.fn(() =>
      Promise.resolve({ status: 200, ok: true, json: async () => ({ cursusViews: [] }) })
    ) as unknown as typeof fetch;
    await service.cursusFor(USER, true, { anonymous: true });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((l) => l.includes(USER.slice(0, 8)))).toEqual([]);
    lines.length = 0;
    global.fetch = jest.fn(answers[0]) as unknown as typeof fetch;
    await service.accountIdentity(USER).catch(() => undefined);
    expect(lines.some((l) => l.includes(USER.slice(0, 8)))).toBe(true);
  });
});
