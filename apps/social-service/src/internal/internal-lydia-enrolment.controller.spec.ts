import { Logger } from '@nestjs/common';
import type { AssociationsService } from '../associations/associations.service';
import type { ProductsService } from '../associations/products.service';
import { LYDIA_ENROLMENT_PENDING } from '../associations/lydia-readiness';
import { InternalLydiaEnrolmentController } from './internal-lydia-enrolment.controller';

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
