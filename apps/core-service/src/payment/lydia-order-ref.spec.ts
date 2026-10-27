import { parseLydiaOrderRef } from './lydia-order-ref';

describe('parseLydiaOrderRef', () => {
  const productId = '11111111-1111-1111-1111-111111111111';
  const checkoutId = '33333333-3333-3333-3333-333333333333';
  // A real user id: a 64-character hex digest, never a UUID.
  const userId = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';

  it('decodes a legacy form order_ref, issued before one per request', () => {
    expect(parseLydiaOrderRef('form:submission-42')).toEqual({
      kind: 'form',
      submissionId: 'submission-42',
    });
  });

  it('decodes a per-request form order_ref to its submission, whichever attempt it names', () => {
    const submissionId = '22222222-2222-2222-2222-222222222222';
    const first = `form:${submissionId}:0a1b2c3d`;
    const second = `form:${submissionId}:ffffffff`;
    // The attempt decides nothing: a callback about an older attempt still names the same row.
    expect(parseLydiaOrderRef(first)).toEqual({ kind: 'form', submissionId });
    expect(parseLydiaOrderRef(second)).toEqual({ kind: 'form', submissionId });
    expect(first.length).toBe(50);
  });

  it('rejects a form order_ref whose attempt is not 8 lowercase hex digits, or that has a third part', () => {
    expect(parseLydiaOrderRef('form:submission-42:not-hex!')).toBeNull();
    expect(parseLydiaOrderRef('form:submission-42:0a1b2c3')).toBeNull();
    expect(parseLydiaOrderRef('form:submission-42:0A1B2C3D')).toBeNull();
    expect(parseLydiaOrderRef(`form:submission-42:${checkoutId}`)).toBeNull();
    expect(parseLydiaOrderRef('form:submission-42:0a1b2c3d:0a1b2c3d')).toBeNull();
    expect(parseLydiaOrderRef('form:submission-42:')).toBeNull();
  });

  it('decodes a product order_ref naming the attempt, and no buyer', () => {
    expect(parseLydiaOrderRef(`product:${productId}:${checkoutId}`)).toEqual({
      kind: 'product',
      productId,
      checkoutId,
    });
  });

  it('stays inside the 109 characters Lydia was measured to accept', () => {
    // The two-part form with a 64-char user id (109) was accepted on the sandbox; nothing longer was.
    expect(`product:${productId}:${checkoutId}`.length).toBe(81);
  });

  it('tells two attempts of one product apart', () => {
    const other = '44444444-4444-4444-4444-444444444444';
    const a = parseLydiaOrderRef(`product:${productId}:${checkoutId}`);
    const b = parseLydiaOrderRef(`product:${productId}:${other}`);
    expect(a).not.toEqual(b);
  });

  it('does not parse the order_ref of before migration 101, nor the four-part draft of #2218', () => {
    // `product:<productId>:<64-hex userId>` named no attempt and never matched a real user id.
    expect(parseLydiaOrderRef(`product:${productId}:${userId}`)).toBeNull();
    expect(parseLydiaOrderRef(`product:${productId}:${userId}:${checkoutId}`)).toBeNull();
  });

  it('rejects a product order_ref whose ids are not UUIDs', () => {
    expect(parseLydiaOrderRef(`product:not-a-uuid:${checkoutId}`)).toBeNull();
    expect(parseLydiaOrderRef(`product:${productId}:not-a-uuid`)).toBeNull();
  });

  it('rejects an unrecognized prefix rather than guessing', () => {
    expect(parseLydiaOrderRef('cotisation:whatever')).toBeNull();
  });

  it('rejects null/undefined/empty', () => {
    expect(parseLydiaOrderRef(null)).toBeNull();
    expect(parseLydiaOrderRef(undefined)).toBeNull();
    expect(parseLydiaOrderRef('')).toBeNull();
  });
});
