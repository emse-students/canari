import { Logger } from '@nestjs/common';
import { FormsService } from './forms.service';
import { FORM_ANSWER_MISSING } from './answer-bounds';

/**
 * A TEXT OR IMAGE BLOCK THROUGH `submit` (`form-blocks.ts`): it is never required, and an answer
 * keyed by it is never stored - whatever a client sends. The cash path returns before the provider,
 * so `saved[0].answers` is what the row would hold.
 */
describe('FormsService.submit with blocks', () => {
  const NAME = { id: 'q_name', label: 'Nom', required: true, type: 'short_text' };
  const TEXT = {
    id: 'b_text',
    label: 'Programme',
    description: 'Rendez-vous a 8h',
    required: false,
    type: 'text_block',
  };
  const IMAGE = {
    id: 'b_img',
    label: '',
    required: false,
    type: 'image_block',
    imageUrl: '/api/media/public/11111111-1111-4111-8111-111111111111',
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
      // The form's seat lock (`lockFormSeats`), taken before the capacity count.
      query: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
      findOne: jest.fn(() => Promise.resolve(null)),
      find: jest.fn(() => Promise.resolve([])),
      create: jest.fn((_entity: unknown, x: Record<string, unknown>) => x),
      save: jest.fn((x: Record<string, unknown>) => {
        saved.push(x);
        return Promise.resolve({ ...x, id: 's1' });
      }),
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
      build: jest.fn((input: { answers?: Record<string, string[]> }) => {
        if (opts.factsError) return Promise.reject(opts.factsError);
        return Promise.resolve({
          cursus: [{ promo: null, formation: null }],
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
      pricingFacts,
      {} as any,
      {} as any,
      // FormOrganiserAlertService: switched off, as it ships.
      { enabled: () => false } as any,
      {} as any
    );
    return { service, pricingFacts, saved };
  }

  const form = {
    id: 'f1',
    title: 'Sortie',
    currency: 'eur',
    basePrice: 0,
    items: [TEXT, NAME, IMAGE],
    allowCashPayment: true,
    allowMultipleSubmissions: true,
    associationId: 'asso1',
    priceMatrix: null,
  };

  const submit = (service: FormsService, answers: Record<string, unknown>) =>
    service.submit('f1', { userId: 'user1', answers, paymentMethod: 'cash' } as any);

  it('sends a form whose blocks carry no answer', async () => {
    const { service, saved } = makeService({ form });
    await submit(service, { q_name: 'Ada' });
    expect(saved[0].answers).toEqual({ q_name: 'Ada' });
  });

  it('drops an answer keyed by a block and says so in the log', async () => {
    const { service, saved } = makeService({ form });
    const blocksWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await submit(service, { q_name: 'Ada', b_text: 'injected', b_img: ['x'] });
    expect(saved[0].answers).toEqual({ q_name: 'Ada' });
    expect(blocksWarn).toHaveBeenCalledWith(expect.stringContaining('keyed by a block dropped'));
    blocksWarn.mockRestore();
  });

  it('still refuses the required question beside the blocks', async () => {
    const { service } = makeService({ form });
    await expect(submit(service, { b_text: 'x' })).rejects.toMatchObject({
      response: expect.objectContaining({ code: FORM_ANSWER_MISSING, itemId: 'q_name' }),
    });
  });
});
