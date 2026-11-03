import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AssociationsController } from '../associations/associations.controller';
import { AssociationCategoriesController } from '../associations/association-categories.controller';
import { FormsController } from '../forms/forms.controller';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';

/**
 * THE ROUTES CLOSED TO A VISITOR WITHOUT AN ACCOUNT ON 2026-11-02, ONE ASSERTION EACH.
 *
 * The owner's rule: without an account Canari shows nothing the public showcase
 * (portail-etu.emse.fr) does not. Each of these served something the showcase never shows - a
 * person's memberships and past roles, a shop, the category list, one agenda entry - and now
 * carries the session guard, which refuses a caller nginx did not identify. The static gate
 * (`.github/scripts/tests/auth-request-coverage.test.mjs`, CLOSED_TO_ANONYMOUS) asserts the same
 * from the routing side. See docs/wiki/anonymous-surface.md.
 */
describe('routes closed to a signed-out caller (anonymous-surface.md)', () => {
  const cases: [string, object, string][] = [
    ['GET /associations/users/:userId/memberships', AssociationsController, 'listUserMemberships'],
    ['GET /associations/users/:userId/role-history', AssociationsController, 'listUserRoleHistory'],
    ['GET /associations/:id/products', AssociationsController, 'listAssociationProducts'],
    ['GET /associations/categories', AssociationCategoriesController, 'list'],
    ['GET /forms/:id/calendar-link', FormsController, 'getFormCalendarLink'],
  ];

  it.each(cases)('%s carries NginxAuthGuard', (_route, controller, method) => {
    const handler = (controller as { prototype: Record<string, object> }).prototype[method];
    const guards = (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[];
    expect(guards).toContain(NginxAuthGuard);
  });
});
