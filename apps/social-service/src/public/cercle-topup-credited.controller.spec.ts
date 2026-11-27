import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CercleTopupCreditedController } from './cercle-topup-credited.controller';

/**
 * Le Cercle's notice that a parked top-up is credited: refused without the Cercle API key, refused
 * without a well-formed payment intent, otherwise handed to `markCercleTopupCredited`.
 */
describe('CercleTopupCreditedController', () => {
  const ORIGINAL = process.env.CERCLE_API_KEY;
  afterEach(() => {
    process.env.CERCLE_API_KEY = ORIGINAL;
  });

  function make(key = 'cercle-key') {
    process.env.CERCLE_API_KEY = key;
    const markCercleTopupCredited = jest.fn(async () => ({ status: 'delivered' as const }));
    const controller = new CercleTopupCreditedController({ markCercleTopupCredited } as never);
    return { controller, markCercleTopupCredited };
  }

  it('settles the named top-up with the right key', async () => {
    const { controller, markCercleTopupCredited } = make();
    await expect(
      controller.topupCredited({ paymentIntentId: 'pi_123' }, 'cercle-key')
    ).resolves.toEqual({ status: 'delivered' });
    expect(markCercleTopupCredited).toHaveBeenCalledWith('pi_123');
  });

  it('refuses a wrong key, a missing key, and every key while none is configured', async () => {
    const { controller, markCercleTopupCredited } = make();
    await expect(controller.topupCredited({ paymentIntentId: 'pi_1' }, 'nope')).rejects.toThrow(
      ForbiddenException
    );
    await expect(
      controller.topupCredited({ paymentIntentId: 'pi_1' }, undefined as never)
    ).rejects.toThrow(ForbiddenException);
    const unset = make('');
    await expect(unset.controller.topupCredited({ paymentIntentId: 'pi_1' }, '')).rejects.toThrow(
      ForbiddenException
    );
    expect(markCercleTopupCredited).not.toHaveBeenCalled();
  });

  it('refuses a body with no well-formed payment intent', async () => {
    const { controller, markCercleTopupCredited } = make();
    for (const body of [undefined, {}, { paymentIntentId: 42 }, { paymentIntentId: 'a b' }]) {
      await expect(controller.topupCredited(body as never, 'cercle-key')).rejects.toThrow(
        BadRequestException
      );
    }
    expect(markCercleTopupCredited).not.toHaveBeenCalled();
  });
});
