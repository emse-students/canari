import { formOrderRef } from './form-order-ref';

describe('formOrderRef', () => {
  const submissionId = '22222222-2222-2222-2222-222222222222';
  const attemptId = '33333333-3333-3333-3333-333333333333';

  it('names the submission and the attempt, inside the 109 characters Lydia was measured to accept', () => {
    const ref = formOrderRef(submissionId, attemptId);
    expect(ref).toBe(`form:${submissionId}:${attemptId}`);
    expect(ref.length).toBe(78);
  });

  // Lydia refuses a second request/do with an order_ref it has seen (error 3, 2026-10-21).
  it('is a different string for every request of one submission', () => {
    const refs = new Set(Array.from({ length: 50 }, () => formOrderRef(submissionId)));
    expect(refs.size).toBe(50);
  });
});
