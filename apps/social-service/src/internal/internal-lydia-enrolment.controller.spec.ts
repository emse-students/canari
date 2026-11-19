import { Logger } from '@nestjs/common';
import type { AssociationsService } from '../associations/associations.service';
import type { ProductsService } from '../associations/products.service';
import { LYDIA_ENROLMENT_PENDING } from '../associations/lydia-readiness';
import { InternalLydiaEnrolmentController } from './internal-lydia-enrolment.controller';
import { InternalLydiaCashiersController } from './internal-lydia-cashiers.controller';
import type { LydiaCashiersService } from '../associations/lydia-cashiers.service';

const SECRET = 'throwaway-internal-secret';
const VENDOR = 'vendor-token-of-a-business';

describe('InternalLydiaEnrolmentController.lydiaReadiness - what core-service classifies', () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = SECRET;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = saved;
  });
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const controllerAnswering = (kind: string) =>
    new InternalLydiaEnrolmentController(
      {} as AssociationsService,
      { markLydiaReady: jest.fn(async () => ({ kind })) } as unknown as ProductsService
    );
  const body = { vendorToken: VENDOR, ready: true, cause: 'webhook-validated' };

  it('the pending enrolment token is a 503 carrying the TYPED code LYDIA_ENROLMENT_PENDING', async () => {
    await expect(
      controllerAnswering('no-holder-enrolment-in-flight').lydiaReadiness(SECRET, body)
    ).rejects.toMatchObject({ status: 503, response: { code: LYDIA_ENROLMENT_PENDING } });
  });

  it('any other unknown token is a 200 no-holder', async () => {
    await expect(controllerAnswering('no-holder').lydiaReadiness(SECRET, body)).resolves.toEqual({
      outcome: 'no-holder',
      associationId: null,
    });
  });
});

describe('a released cashier claim asks the departures again (claim-released)', () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = SECRET;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = saved;
  });

  const ASSO = '00000000-0000-4000-8000-0000000000c1';
  const TOKEN = '00000000-0000-4000-8000-00000000000a';

  it('the Responsable release and record ask - except a record answering removeOther', async () => {
    const afterCashierClaimReleased = jest.fn();
    const releaseLydiaResponsable = jest.fn(async () => true);
    const recordLydiaResponsable = jest
      .fn()
      .mockResolvedValueOnce({ view: {}, cashierId: 'c', removeOther: true })
      .mockResolvedValueOnce({ view: {}, cashierId: 'c', removeOther: false })
      .mockRejectedValueOnce(new Error('claim lost'));
    const controller = new InternalLydiaEnrolmentController(
      {
        afterCashierClaimReleased,
        releaseLydiaResponsable,
        recordLydiaResponsable,
      } as unknown as AssociationsService,
      {} as ProductsService
    );
    await controller.responsableRelease(SECRET, ASSO, { claimToken: TOKEN });
    expect(afterCashierClaimReleased).toHaveBeenCalledTimes(1);
    // removeOther: core's removal of the replaced number claims next - its release asks instead.
    await controller.recordResponsable(SECRET, ASSO, { claimToken: TOKEN });
    expect(afterCashierClaimReleased).toHaveBeenCalledTimes(1);
    await controller.recordResponsable(SECRET, ASSO, { claimToken: TOKEN });
    expect(afterCashierClaimReleased).toHaveBeenCalledTimes(2);
    await expect(controller.recordResponsable(SECRET, ASSO, { claimToken: TOKEN })).rejects.toThrow(
      'claim lost'
    );
    expect(afterCashierClaimReleased).toHaveBeenCalledTimes(3);
  });

  it('the cashier record, release and removal record ask once each', async () => {
    const settleDepartures = jest.fn(async () => undefined);
    const controller = new InternalLydiaCashiersController({
      settleDepartures,
      record: jest.fn(async () => ({})),
      release: jest.fn(async () => true),
      recordRevoke: jest.fn(async () => undefined),
    } as unknown as LydiaCashiersService);
    await controller.record(SECRET, ASSO, { claimToken: TOKEN });
    await controller.release(SECRET, ASSO, { claimToken: TOKEN });
    await controller.recordRevoke(SECRET, ASSO, {
      cashierId: TOKEN,
      number: 'current',
      verified: true,
      cashierPhone: '+33612345678',
      claimToken: TOKEN,
    });
    expect(settleDepartures.mock.calls).toEqual([
      [ASSO, 'claim-released'],
      [ASSO, 'claim-released'],
      [ASSO, 'claim-released'],
    ]);
  });
});
