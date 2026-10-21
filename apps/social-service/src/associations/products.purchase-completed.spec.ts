import { Logger } from '@nestjs/common';
import { ProductsService } from './products.service';

/**
 * A BOUTIQUE PURCHASE IS SETTLED ONLY FOR THE BUSINESS ITS ATTEMPT WAS ISSUED TO. The callback
 * reaching here was verified by core-service with the Business key of `vendorToken`; an authentic
 * callback of association A naming an attempt of association B in its `order_ref` reads nothing and
 * records nothing. The payee is the attempt's OWN paying account (`paymentAssociationId`, resolved
 * when the request was issued), the one its request is read at Lydia with.
 */
describe('ProductsService.handlePurchaseCompleted - the verified Business must be the payee', () => {
  const CHECKOUT = '33333333-3333-4333-8333-333333333333';

  function makeService(payee: string | null) {
    const read = jest.fn(() => Promise.resolve('paid'));
    const service = Object.assign(Object.create(ProductsService.prototype) as object, {
      logger: new Logger('ProductsService'),
      checkoutRepo: {
        findOne: jest.fn(() =>
          Promise.resolve({
            id: CHECKOUT,
            productId: 'prod-1-uuid',
            paymentAssociationId: 'asso-b',
            requestId: 'r1',
            status: 'open',
          })
        ),
      },
      assoRepo: {
        findOne: jest.fn(() => Promise.resolve({ id: 'asso-b', lydiaAccountId: payee })),
      },
      readAndApplyRequestState: read,
    }) as unknown as ProductsService;
    return { service, read };
  }

  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('settles an attempt whose verified Business is the one it was issued to', async () => {
    const { service, read } = makeService('vendor-b');
    await expect(
      service.handlePurchaseCompleted('prod-1-uuid', CHECKOUT, 'r1', 'vendor-b')
    ).resolves.toEqual({ outcome: 'paid' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another association', 'vendor-b'],
    ['an association with no Lydia account any more', null],
  ])('reads and records nothing when the attempt is paid into %s', async (_case, payee) => {
    const { service, read } = makeService(payee);
    await expect(
      service.handlePurchaseCompleted('prod-1-uuid', CHECKOUT, 'r1', 'vendor-a')
    ).resolves.toEqual({ outcome: 'refused' });
    expect(read).not.toHaveBeenCalled();
  });
});
