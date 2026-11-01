import { FormsService } from './forms.service';

/**
 * NOTHING IS SUBMITTED OR BOUGHT ACROSS THE REVIEW COHORT (review-cohort.ts, review-cohort-reach.ts):
 * a review account answers only the forms of an association it belongs to, and nobody answers a
 * personal form across the boundary, in either direction. The refusal comes before any other check,
 * so the form below is otherwise one that would be refused for being closed - a test that reached
 * that refusal instead would fail on the code.
 */
describe('FormsService.submit and the review cohort', () => {
  const saved = process.env.SERVICE_ACCOUNT_USER_ID;
  afterEach(() => {
    if (saved === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
    else process.env.SERVICE_ACCOUNT_USER_ID = saved;
  });

  function makeService(form: Record<string, unknown>, reviewerMemberships: string[] = []) {
    const formRepo = {
      findOne: jest.fn(() =>
        Promise.resolve({ items: [], closedAt: new Date('2000-01-01T00:00:00Z'), ...form })
      ),
      manager: {
        query: jest.fn(() =>
          Promise.resolve(reviewerMemberships.map((associationId) => ({ associationId })))
        ),
      },
    };
    const none = {} as never;
    const service = new FormsService(
      formRepo as never,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      { enabled: () => false } as never
    );
    return service;
  }

  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => 'accepted',
      (e: { getResponse?: () => { code?: string } }) => e.getResponse?.().code ?? 'other'
    );

  it.each([
    ['a review account answering a member', 'reviewer', 'owner', 'reviewer'],
    ["a member answering a review account's form", 'owner', 'owner', 'member'],
  ])('refuses %s personal form, typed', async (_case, cohort, ownerId, userId) => {
    process.env.SERVICE_ACCOUNT_USER_ID = cohort;
    const service = makeService({ id: 'f1', ownerId, associationId: null });
    await expect(refusal(service.submit('f1', { userId, answers: {} } as never))).resolves.toBe(
      'REVIEW_COHORT_BOUNDARY'
    );
  });

  it("refuses a review account a real association's form, and lets it answer its own association's", async () => {
    process.env.SERVICE_ACCOUNT_USER_ID = 'reviewer';
    const real = makeService({ id: 'f1', ownerId: 'owner', associationId: 'asso1' });
    await expect(
      refusal(real.submit('f1', { userId: 'reviewer', answers: {} } as never))
    ).resolves.toBe('REVIEW_COHORT_BOUNDARY');
    const demo = makeService({ id: 'f1', ownerId: 'owner', associationId: 'demo' }, ['demo']);
    // Past the boundary, the form's own refusal (closed) answers - not the cohort's.
    await expect(
      refusal(demo.submit('f1', { userId: 'reviewer', answers: {} } as never))
    ).resolves.not.toBe('REVIEW_COHORT_BOUNDARY');
  });

  it('lets two members, and a member on an association form, past the boundary', async () => {
    process.env.SERVICE_ACCOUNT_USER_ID = 'reviewer';
    for (const form of [
      { id: 'f1', ownerId: 'owner', associationId: null },
      { id: 'f1', ownerId: 'owner', associationId: 'asso1' },
    ]) {
      const service = makeService(form);
      await expect(
        refusal(service.submit('f1', { userId: 'member', answers: {} } as never))
      ).resolves.not.toBe('REVIEW_COHORT_BOUNDARY');
    }
  });
});
