import { Logger } from '@nestjs/common';
import { ProductsService } from './products.service';

/**
 * A BOUTIQUE PURCHASE IS SETTLED ONLY FOR THE BUSINESS ITS ATTEMPT WAS ISSUED TO. The callback
 * reaching here was verified by core-service with the Business key of `vendorToken`; an authentic
 * callback of association A naming an attempt of association B in its `order_ref` reads nothing and
 * records nothing. The payee is the attempt's OWN `vendorToken`, snapshotted when its request was
 * issued: the association's CURRENT account decides nothing, so a Business relinked after the issue
 * neither settles the old attempt nor stops the Business that holds the request from settling it.
 */
describe('ProductsService.handlePurchaseCompleted - the verified Business must be the payee', () => {
  const CHECKOUT = '33333333-3333-4333-8333-333333333333';

  function makeService(issuedTo: string) {
    const read = jest.fn(() => Promise.resolve('paid'));
    const service = Object.assign(Object.create(ProductsService.prototype) as object, {
      logger: new Logger('ProductsService'),
      checkoutRepo: {
        findOne: jest.fn(() =>
          Promise.resolve({
            id: CHECKOUT,
            productId: 'prod-1-uuid',
            paymentAssociationId: 'asso-b',
            vendorToken: issuedTo,
            requestId: 'r1',
            status: 'open',
          })
        ),
      },
      // The association has relinked ANOTHER Business since the attempt was issued.
      assoRepo: {
        findOne: jest.fn(() => Promise.resolve({ id: 'asso-b', lydiaAccountId: 'vendor-b-new' })),
      },
      readAndApplyRequestState: read,
      completePaidWithoutRequestId: jest.fn(() => Promise.resolve()),
    }) as unknown as ProductsService;
    return { service, read };
  }

  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('settles an attempt verified by the Business it was issued to, even after a relink', async () => {
    const { service, read } = makeService('vendor-b');
    await expect(
      service.handlePurchaseCompleted('prod-1-uuid', CHECKOUT, 'r1', 'vendor-b')
    ).resolves.toEqual({ outcome: 'paid' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another association', 'vendor-a'],
    // CONTROL: read from the association's CURRENT account, this callback would be accepted.
    ["the association's newly linked Business, not the one holding the request", 'vendor-b-new'],
  ])('reads and records nothing when the callback is verified for %s', async (_case, verified) => {
    const { service, read } = makeService('vendor-b');
    await expect(
      service.handlePurchaseCompleted('prod-1-uuid', CHECKOUT, 'r1', verified)
    ).resolves.toEqual({ outcome: 'refused' });
    expect(read).not.toHaveBeenCalled();
  });
});
