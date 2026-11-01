import { Repository } from 'typeorm';
import { InternalController } from './internal.controller';
import type { Association } from '../associations/entities/association.entity';
import type { AssociationMember } from '../associations/entities/association-member.entity';
import type { AssociationRoleHistory } from '../associations/entities/association-role-history.entity';

/**
 * `GET internal/users/:userId/associations` feeds Sky's profile panel through core-service's
 * `/api/external/profile/:sub`. Sky tells associations, campaign lists and institutions apart with
 * `type` + `promo`, and de-duplicates a past mandate against a current one by `slug`: all three
 * are additive fields and must reach both arrays.
 */
describe('InternalController.listUserAssociations', () => {
  const asso = (o: Partial<Association>) => ({ archived: false, logoUrl: null, promo: null, ...o });
  const assocs = [
    asso({ id: 'a1', name: 'T', slug: 't', type: 'association' }),
    asso({ id: 'l1', name: 'Liste', slug: 'liste', type: 'list', promo: 2027 }),
    asso({ id: 'i1', name: 'Inst', slug: 'inst', type: 'institution' }),
    asso({ id: 'x1', name: 'Old', slug: 'old', type: 'association', archived: true }),
  ] as Association[];

  const controller = new InternalController(
    {} as never,
    { find: jest.fn(async () => assocs) } as unknown as Repository<Association>,
    {
      find: jest.fn(async () => [
        { associationId: 'a1', role: 'Secrétaire' },
        { associationId: 'l1', role: 'Membre' },
        { associationId: 'i1', role: 'Membre' },
        { associationId: 'x1', role: 'Membre' },
      ]),
    } as unknown as Repository<AssociationMember>,
    {
      find: jest.fn(async () => [
        { associationId: 'a1', roleTitle: 'Secrétaire', startYear: 2024, endYear: 2025 },
        { associationId: 'gone', roleTitle: 'Trésorier', startYear: 2022, endYear: 2023 },
      ]),
    } as unknown as Repository<AssociationRoleHistory>,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );

  beforeEach(() => {
    process.env.INTERNAL_SECRET = 'shared-secret';
  });

  it('carries type and promo on every current row', async () => {
    const { current } = await controller.listUserAssociations('u', 'shared-secret');
    expect(current.map((c) => [c.slug, c.type, c.promo])).toEqual([
      ['t', 'association', null],
      ['liste', 'list', 2027],
      ['inst', 'institution', null],
    ]);
  });

  it('carries type, promo and slug on every former row, even an archived or a vanished one', async () => {
    const { former } = await controller.listUserAssociations('u', 'shared-secret');
    expect(former).toEqual([
      expect.objectContaining({ slug: 'old', type: 'association', promo: null, startYear: null }),
      expect.objectContaining({ slug: 't', type: 'association', startYear: 2024, endYear: 2025 }),
      expect.objectContaining({
        slug: null,
        type: 'association',
        promo: null,
        name: 'Association',
      }),
    ]);
  });
});
