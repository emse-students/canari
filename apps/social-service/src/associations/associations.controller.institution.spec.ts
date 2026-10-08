import { ForbiddenException } from '@nestjs/common';
import { AssociationsController } from './associations.controller';
import { parseDirectoryQuery } from './directory-query';
import { REPUBLISHING_ASSOCIATION_TYPES } from '../posts/republication-sql';

/**
 * WP6e (D20, D24): an INSTITUTION is created by a global admin ONLY. A BDE member holding
 * MANAGE_ASSO creates associations within its own space; an institution crosses spaces, so that
 * flag never reaches it - and the refusal comes before any write.
 */
describe('AssociationsController.create - institutions', () => {
  function makeController(bdeCanCreate: boolean) {
    const service = {
      callerHasAnyBdeFlag: jest.fn(() => Promise.resolve(bdeCanCreate)),
      create: jest.fn(() => Promise.resolve({ id: 'new' })),
    };
    const controller = new AssociationsController(
      service as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    return { controller, service };
  }
  const dto = (type?: 'association' | 'list' | 'institution') =>
    ({ name: 'Ecole', slug: 'ecole', type }) as never;

  it('lets a global admin create one', async () => {
    const { controller, service } = makeController(false);
    await controller.create('admin', 'true', dto('institution'));
    expect(service.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a BDE member holding MANAGE_ASSO, before any write', async () => {
    const { controller, service } = makeController(true);
    await expect(controller.create('bde', undefined, dto('institution'))).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(service.create).not.toHaveBeenCalled();
  });

  it('still lets that BDE member create an ordinary association', async () => {
    const { controller, service } = makeController(true);
    await controller.create('bde', undefined, dto('association'));
    expect(service.create).toHaveBeenCalledTimes(1);
  });
});

describe('institutions in the listings and the republishing allowlist', () => {
  it('the directory query keeps type=institution', () => {
    expect(parseDirectoryQuery({ type: 'institution' }).type).toBe('institution');
  });

  it('an institution republishes, a promo list does not', () => {
    expect(REPUBLISHING_ASSOCIATION_TYPES).toContain('institution');
    expect(REPUBLISHING_ASSOCIATION_TYPES).not.toContain('list');
  });
});
