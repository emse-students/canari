import { parseLydiaOrderRef } from './lydia-order-ref';

describe('parseLydiaOrderRef', () => {
  it('decodes a form order_ref', () => {
    expect(parseLydiaOrderRef('form:submission-42')).toEqual({
      kind: 'form',
      submissionId: 'submission-42',
    });
  });

  it('decodes a product order_ref', () => {
    const productId = '11111111-1111-1111-1111-111111111111';
    const userId = '22222222-2222-2222-2222-222222222222';
    expect(parseLydiaOrderRef(`product:${productId}:${userId}`)).toEqual({
      kind: 'product',
      productId,
      userId,
    });
  });

  it('rejects a product order_ref whose ids are not UUIDs', () => {
    expect(parseLydiaOrderRef('product:not-a-uuid:also-not')).toBeNull();
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
