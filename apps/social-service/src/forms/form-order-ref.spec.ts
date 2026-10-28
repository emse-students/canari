import { FORM_ORDER_REF_MAX_LENGTH, formOrderRef } from './form-order-ref';

describe('formOrderRef', () => {
  const submissionId = '22222222-2222-2222-2222-222222222222';

  it('names the submission and an 8-hex-digit attempt', () => {
    expect(formOrderRef(submissionId)).toMatch(new RegExp(`^form:${submissionId}:[0-9a-f]{8}$`));
  });

  // Lydia's apiDoc names no maximum; 109 characters is what was measured accepted. A longer
  // order_ref would be refused on EVERY form payment, so the length is pinned, not described.
  it(`never exceeds ${FORM_ORDER_REF_MAX_LENGTH} characters for a uuid submission id`, () => {
    expect(FORM_ORDER_REF_MAX_LENGTH).toBe(50);
    for (let i = 0; i < 100; i++) {
      expect(formOrderRef(submissionId).length).toBe(FORM_ORDER_REF_MAX_LENGTH);
    }
  });

  // Lydia refuses a second request/do with an order_ref it has seen (error 3, 2026-10-21).
  it('is a different string for every request of one submission', () => {
    const refs = new Set(Array.from({ length: 50 }, () => formOrderRef(submissionId)));
    expect(refs.size).toBe(50);
  });
});
