import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { FormsService } from './forms.service';
import { FORM_ANSWER_PAID } from './answer-bounds';

/**
 * AN ANSWER WHOSE PAYMENT WAS RECEIVED IS NEVER DELETED (owner, 2026-11-14): its manager refunds or
 * cancels it instead, and the refusal is TYPED (`FORM_ANSWER_PAID`), never prose. The status is
 * tested in the DELETE's own WHERE, so a payment confirmed after the read is refused too.
 */
function serviceWith(rows: { deleted: unknown[]; after: { paymentStatus: string } | null }) {
  const service = Object.create(FormsService.prototype) as FormsService;
  const query = jest.fn(async () => rows.deleted);
  const findOne = jest
    .fn()
    .mockResolvedValueOnce({ id: 's1', formId: 'f1', paymentStatus: 'pending' })
    .mockResolvedValueOnce(rows.after ? { id: 's1', ...rows.after } : null);
  Object.assign(service, {
    submissionRepo: { findOne, query },
    logger: new Logger('test'),
    assertFormManager: jest.fn(async () => ({ id: 'f1' })),
  });
  return { service, query };
}

describe('FormsService.deleteSubmission', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('deletes an unpaid answer, the paid statuses excluded in the statement itself', async () => {
    const { service, query } = serviceWith({ deleted: [{ id: 's1' }], after: null });
    await expect(service.deleteSubmission('s1', 'manager', false)).resolves.toBeUndefined();
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('"paymentStatus" <> ALL');
    expect(params[1]).toEqual(['paid', 'paid_over_capacity']);
  });

  it('refuses a paid answer with the typed 409, whatever the first read saw', async () => {
    const { service } = serviceWith({ deleted: [], after: { paymentStatus: 'paid' } });
    const err = await service.deleteSubmission('s1', 'manager', false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: FORM_ANSWER_PAID });
  });

  it('is a 404 when the answer went meanwhile', async () => {
    const { service } = serviceWith({ deleted: [], after: null });
    await expect(service.deleteSubmission('s1', 'manager', false)).rejects.toBeInstanceOf(
      NotFoundException
    );
  });
});
