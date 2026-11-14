import { Logger } from '@nestjs/common';
import { AssociationsService } from './associations.service';
import { AssociationPermissionFlag } from './entities/association-member.entity';

/**
 * WHO MAY READ THE FEE SCHEDULE: whoever may edit a price somewhere (owner, 2026-11-14), built from
 * the rights that guard the price editors - never a new axis.
 */
function serviceWith(opts: {
  mine?: Array<{ type: string; permissions: number }>;
  superAdmin?: boolean;
}) {
  const service = Object.create(AssociationsService.prototype) as AssociationsService;
  Object.assign(service, {
    logger: new Logger('test'),
    listByUser: jest.fn(async () => opts.mine ?? []),
    isAssociationSuperAdmin: jest.fn(async () => opts.superAdmin === true),
  });
  return { service };
}

describe('AssociationsService.mayEditAPrice', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('answers a global admin', async () => {
    const { service } = serviceWith({});
    await expect(service.mayEditAPrice('u', true)).resolves.toBe(true);
  });

  it.each([
    ['the shop', AssociationPermissionFlag.MANAGE_PRODUCTS, 'association'],
    ['the forms', AssociationPermissionFlag.MANAGE_FORMS, 'association'],
    ['a list form', AssociationPermissionFlag.MANAGE_FORMS, 'list'],
  ])('answers a member who manages %s', async (_what, flag, type) => {
    const { service } = serviceWith({ mine: [{ type, permissions: flag }] });
    await expect(service.mayEditAPrice('u', false)).resolves.toBe(true);
  });

  it('refuses an institution manager, whose entity collects nothing', async () => {
    const { service } = serviceWith({
      mine: [{ type: 'institution', permissions: AssociationPermissionFlag.MANAGE_FORMS }],
    });
    await expect(service.mayEditAPrice('u', false)).resolves.toBe(false);
  });

  it('answers a BDE super-admin', async () => {
    await expect(serviceWith({ superAdmin: true }).service.mayEditAPrice('u', false)).resolves.toBe(
      true
    );
  });

  it('refuses a plain member, whatever forms they created: creating one is no right over prices', async () => {
    const { service } = serviceWith({ mine: [{ type: 'association', permissions: 0 }] });
    await expect(service.mayEditAPrice('u', false)).resolves.toBe(false);
  });

  it('refuses a student who edits no price', async () => {
    const { service } = serviceWith({
      mine: [{ type: 'association', permissions: AssociationPermissionFlag.MANAGE_MEMBERS }],
    });
    await expect(service.mayEditAPrice('u', false)).resolves.toBe(false);
  });
});
