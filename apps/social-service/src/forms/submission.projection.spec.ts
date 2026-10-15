import { FormsService } from './forms.service';
import type { Submission } from './entities/submission.entity';

/**
 * NO SUBMISSION RESPONSE CARRIES A PAYMENT ACCOUNT KEY OR A PROVIDER ID (2026-10-15).
 *
 * `GET forms/submissions/:id` answered the Business's Lydia `vendor_token` to every submitter;
 * with it and a sequential `request_id`, `request/cancel` cancels anybody's open payment request
 * to that Business. The row below carries EVERY private column filled with a recognisable value,
 * the association answers a recognisable vendor token, and each client-facing read is checked for
 * any of them - by value, so a renamed key cannot slip through, and by key, so a new column named
 * like one cannot either.
 */
describe('submission responses - nothing a client could pay or cancel with', () => {
  const VENDOR_TOKEN = 'vendor-token-SECRET-7f3a';
  const PRIVATE_VALUES: Partial<Submission> = {
    stripeSessionId: 'uuid-SECRET-077f2efc',
    paymentRequestId: '12115506',
    paymentSettledBy: 'settled-SECRET',
    cotisationGrantedAt: new Date('2026-10-15T01:02:03Z'),
    purchaseRecordedAt: new Date('2026-10-15T04:05:06Z'),
    paymentRequestedAt: new Date('2026-10-15T07:08:09Z'),
  };
  const row: Submission = {
    id: '11111111-1111-4111-8111-111111111111',
    formId: 'f1',
    userId: 'user-SECRET-owner',
    email: 'payer@example.com',
    answers: { q1: ['a'] },
    totalPaid: 1500,
    paymentStatus: 'pending_cash',
    paymentMethod: 'cash',
    cashExpiresAt: null,
    createdAt: new Date('2026-10-14T00:00:00Z'),
    updatedAt: new Date('2026-10-14T00:00:00Z'),
    ...PRIVATE_VALUES,
  } as Submission;

  /** Keys a client response must never carry, whatever their value. */
  const FORBIDDEN_KEY =
    /account|vendor|token|lydia|stripe|session|request|settled|granted|recorded/i;

  function makeService() {
    const submissionRepo: any = {
      findOne: jest.fn(async () => ({ ...row })),
      find: jest.fn(async () => [{ ...row }]),
      manager: { query: jest.fn(async () => []) },
    };
    const formRepo: any = {
      findOne: jest.fn(async () => ({ id: 'f1', associationId: 'a1', currency: 'eur', items: [] })),
    };
    const associationsService: any = {
      getPaymentAccountId: jest.fn(async () => VENDOR_TOKEN),
    };
    const service = new FormsService(
      formRepo,
      submissionRepo,
      {} as any,
      { get: jest.fn() } as any,
      associationsService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    jest.spyOn(service, 'assertFormManager').mockResolvedValue({} as any);
    return service;
  }

  function assertNothingPrivate(response: unknown) {
    const json = JSON.stringify(response);
    expect(json).not.toContain(VENDOR_TOKEN);
    for (const value of Object.values(PRIVATE_VALUES)) {
      expect(json).not.toContain(value instanceof Date ? value.toISOString() : String(value));
    }
    const keys: string[] = [];
    JSON.parse(json, (key, value) => {
      if (key) keys.push(key);
      return value;
    });
    expect(keys.filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);
  }

  it('GET submissions/:id (submitter or manager): no vendor token, no provider id, no userId', async () => {
    const response = await makeService().getSubmissionById(row.id);
    assertNothingPrivate(response);
    expect(response).not.toHaveProperty('userId');
    expect(response).toEqual({
      id: row.id,
      formId: 'f1',
      totalPaid: 1500,
      currency: 'eur',
      paymentStatus: 'pending_cash',
    });
  });

  it("GET :id/submission (the caller's own answer): no provider id, no userId", async () => {
    const response = await makeService().getSubmission('f1', 'user-SECRET-owner');
    assertNothingPrivate(response);
    expect(JSON.stringify(response)).not.toContain('user-SECRET-owner');
    expect(response).toMatchObject({ answers: { q1: ['a'] } });
  });

  it('GET :id/submissions (manager list): no provider id, the submitter still named', async () => {
    const [response] = await makeService().getSubmissions('f1');
    assertNothingPrivate(response);
    expect(response).toMatchObject({ userId: 'user-SECRET-owner', email: 'payer@example.com' });
  });

  it('GET :id/submissions/pending-cash (manager list): no provider id', async () => {
    const [response] = await makeService().listPendingCash('f1', 'manager', false);
    assertNothingPrivate(response);
    expect(response).toMatchObject({ id: row.id, userId: 'user-SECRET-owner', totalPaid: 1500 });
  });
});
