import { Logger } from '@nestjs/common';
import { ProductsService } from './products.service';

/**
 * A BOUTIQUE PURCHASE IS FULFILLED ONLY FOR THE BUSINESS THE PRODUCT IS PAID INTO. The callback
 * reaching here was verified by core-service with the Business key of `vendorToken`; an authentic
 * callback of association A naming a product of association B in its `order_ref` grants nothing.
 */
describe('ProductsService.handlePurchaseCompleted - the verified Business must be the payee', () => {
  function makeService(payee: string | null) {
    const fulfil = jest.fn(() => Promise.resolve({}));
    const service = Object.assign(Object.create(ProductsService.prototype) as object, {
      logger: new Logger('ProductsService'),
      purchaseRecordService: { findByPaymentIntent: jest.fn(() => Promise.resolve(null)) },
      productRepo: {
        findOne: jest.fn(() => Promise.resolve({ id: 'prod-1-uuid', associationId: 'asso-b' })),
      },
      associationsService: { getLydiaPayeeAccountId: jest.fn(() => Promise.resolve(payee)) },
      fulfillProductPurchase: fulfil,
    }) as unknown as ProductsService;
    return { service, fulfil };
  }

  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('fulfils a purchase whose verified Business is the product payee', async () => {
    const { service, fulfil } = makeService('vendor-b');
    await service.handlePurchaseCompleted('prod-1-uuid', 'u1', 500, 'r1', 'vendor-b');
    expect(fulfil).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another association', 'vendor-b'],
    ['an association with no Lydia payee', null],
  ])('grants nothing when the product is paid into %s', async (_case, payee) => {
    const { service, fulfil } = makeService(payee);
    await service.handlePurchaseCompleted('prod-1-uuid', 'u1', 500, 'r1', 'vendor-a');
    expect(fulfil).not.toHaveBeenCalled();
  });
});
