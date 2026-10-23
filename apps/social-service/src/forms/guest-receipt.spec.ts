import {
  guestReference,
  hashGuestReceipt,
  isGuestReceiptShape,
  newGuestReceipt,
  toGuestReceiptView,
} from './guest-receipt';

describe('guest receipt', () => {
  it('mints 256 random bits as 43 base64url characters, and stores their SHA-256', () => {
    const { token, hash } = newGuestReceipt();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashGuestReceipt(token));
    expect(newGuestReceipt().token).not.toBe(token);
  });

  it('knows a receipt by its shape alone', () => {
    expect(isGuestReceiptShape(newGuestReceipt().token)).toBe(true);
    for (const other of [
      '',
      'a'.repeat(42),
      'a'.repeat(44),
      'a'.repeat(42) + '=',
      'a'.repeat(42) + '+',
      '0f7a0c1e-1d2b-4c3d-8e4f-5a6b7c8d9e0f',
      'f'.repeat(64),
      null,
      42,
      { receipt: 'a'.repeat(43) },
    ]) {
      expect(isGuestReceiptShape(other)).toBe(false);
    }
  });

  it('reads a reference as the first eight hex digits of the answer, in two groups', () => {
    expect(guestReference('0f7a0c1e-1d2b-4c3d-8e4f-5a6b7c8d9e0f')).toBe('0F7A-0C1E');
  });

  // An allowlist. Control (2026-10-22): `...answer` spread into the view -> the id reached the
  // guest and this test failed.
  it('answers a guest exactly the allowlisted fields - never the submission id', () => {
    const view = toGuestReceiptView({
      id: '0f7a0c1e-1d2b-4c3d-8e4f-5a6b7c8d9e0f',
      formId: 'f1',
      totalPaid: 1200,
      currency: 'eur',
      paymentStatus: 'paid',
      requestState: 'paid',
      ...({ stripeSessionId: 'uuid', paymentRequestId: '9001', answers: { q: 'Ada' } } as object),
    });
    expect(view).toEqual({
      reference: '0F7A-0C1E',
      formId: 'f1',
      totalPaid: 1200,
      currency: 'eur',
      paymentStatus: 'paid',
      requestState: 'paid',
    });
    expect(
      Object.keys(toGuestReceiptView({ ...view, id: 'x', requestState: undefined })).sort()
    ).toEqual(['currency', 'formId', 'paymentStatus', 'reference', 'totalPaid']);
  });
});
