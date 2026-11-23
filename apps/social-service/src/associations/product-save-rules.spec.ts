import { assertCustomBoundsPayable, assertProductHasPrice } from './product-save-rules';

const logger = { warn: jest.fn() };

describe('assertProductHasPrice', () => {
  const none = { type: 'other', amountCents: null, allowCustomAmount: false, priceMatrix: null };

  it('refuses a product nothing prices, typed', () => {
    expect(() => assertProductHasPrice(none, logger, 'create')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'PRODUCT_HAS_NO_PRICE' }),
      })
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it.each([
    ['a fixed amount', { amountCents: 500 }],
    ['a free amount', { allowCustomAmount: true }],
    ['a grid', { priceMatrix: { dimensions: [] } }],
    ['a membership tier (ranked by its own rules)', { type: 'membership' }],
  ])('accepts %s', (_name, patch) => {
    expect(() => assertProductHasPrice({ ...none, ...patch }, logger, 'update')).not.toThrow();
  });
});

describe('assertCustomBoundsPayable', () => {
  it('refuses a bound outside 0.50-1000 EUR with the payable range', () => {
    for (const bounds of [
      { customAmountMinCents: 10 },
      { customAmountMaxCents: 100_001 },
      { customAmountMinCents: 200_000 },
    ]) {
      expect(() => assertCustomBoundsPayable(bounds, logger)).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'AMOUNT_OUT_OF_RANGE',
            minCents: 50,
            maxCents: 100_000,
          }),
        })
      );
    }
  });

  it('accepts the edges, and ignores a bound the request does not set', () => {
    expect(() =>
      assertCustomBoundsPayable({ customAmountMinCents: 50, customAmountMaxCents: 100_000 }, logger)
    ).not.toThrow();
    expect(() =>
      assertCustomBoundsPayable(
        { customAmountMinCents: null, customAmountMaxCents: undefined },
        logger
      )
    ).not.toThrow();
  });
});
