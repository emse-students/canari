import { MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import { AppModule } from './app.module';
import { ROUTE_PARAMS_GUARD, ROUTE_PARAMS_KEY, RouteParamsGuard } from './common/route-params';
import type { RouteParamKinds } from './common/route-params';

/**
 * EVERY PATH PARAMETER OF A CONVERTED CONTROLLER IS DECLARED, AND EVERY DECLARATION NAMES A REAL
 * ONE (docs/wiki/services/social-service.md, "Path parameters are declared").
 *
 * The declaration (`@RouteParams`) is what the global guard reads, so a route parameter nobody
 * declared is validated by nothing, and a declaration with a typo validates nothing while looking
 * like it does. Both fail here. The controllers are found by walking `AppModule`'s own module
 * graph, so a controller added to any module is judged without being listed anywhere.
 */

type Ctor = { name: string; prototype: object };
interface Route {
  handler: string;
  path: string;
  params: string[];
  own: RouteParamKinds;
}
interface Controller {
  name: string;
  declared: RouteParamKinds;
  routes: Route[];
}

/**
 * THE CONTROLLERS NOT CONVERTED YET - a list that only shrinks. A name leaves it in the pull
 * request that declares its parameters; the last test fails on a name that no longer belongs.
 */
const PENDING = new Set([
  'AccountBellsController',
  'AssociationAudiencesController',
  'BirthdaysController',
  'BookingCalendarController',
  'BookingSpacesController',
  'BookingsController',
  'CoorganisationController',
  'FollowRequestsController',
  'FormsController',
  'InternalChannelReadController',
  'InternalController',
  'InternalFormsController',
  'InternalInvitesController',
  'InternalLydiaCashiersController',
  'InternalLydiaEnrolmentController',
  'LiveChatController',
  'LivesController',
  'MemberRepostsController',
  'MinesweeperController',
  'ModerationController',
  'PosterController',
  'PostsController',
  'ProposalsController',
  'PublicController',
  'PublicFormsController',
  'RefundsController',
  'RepublicationsController',
  'SpacePinsController',
  'SpacesController',
]);

/** Every controller class reachable from a module, dynamic modules and forward references included. */
function controllersOf(root: unknown, seen = new Set<unknown>()): Ctor[] {
  const entry = (root as { forwardRef?: () => unknown })?.forwardRef?.() ?? root;
  const dynamic = entry as { module?: unknown; imports?: unknown[]; controllers?: Ctor[] };
  const cls = dynamic?.module ?? entry;
  if (!cls || seen.has(cls)) return [];
  seen.add(cls);
  const imports = [
    ...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, cls as object) as unknown[]) ?? []),
    ...(dynamic.module ? (dynamic.imports ?? []) : []),
  ];
  const own = [
    ...((Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, cls as object) as Ctor[]) ?? []),
    ...(dynamic.module ? (dynamic.controllers ?? []) : []),
  ];
  return [...own, ...imports.flatMap((m) => controllersOf(m, seen))];
}

const paramsIn = (path: string) => [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
const asList = (p: unknown): string[] => (Array.isArray(p) ? p : [p]).map((s) => String(s ?? ''));

function describeController(cls: Ctor): Controller {
  const prefixes = asList(Reflect.getMetadata(PATH_METADATA, cls));
  const routes: Route[] = [];
  for (const handler of Object.getOwnPropertyNames(cls.prototype)) {
    const fn = (cls.prototype as Record<string, unknown>)[handler];
    if (handler === 'constructor' || typeof fn !== 'function') continue;
    const paths: unknown = Reflect.getMetadata(PATH_METADATA, fn);
    if (paths === undefined) continue;
    for (const prefix of prefixes) {
      for (const path of asList(paths)) {
        const full = `${prefix}/${path}`;
        routes.push({
          handler,
          path: full,
          params: paramsIn(full),
          own: Reflect.getMetadata(ROUTE_PARAMS_KEY, fn) ?? {},
        });
      }
    }
  }
  return { name: cls.name, declared: Reflect.getMetadata(ROUTE_PARAMS_KEY, cls) ?? {}, routes };
}

/** What is wrong with one controller's declarations; empty when nothing is. */
function faults(c: Controller): string[] {
  const out: string[] = [];
  for (const r of c.routes) {
    const kinds = { ...c.declared, ...r.own };
    for (const p of r.params) {
      if (!(p in kinds))
        out.push(`${c.name}.${r.handler} (${r.path}): ":${p}" is declared nowhere`);
    }
    for (const p of Object.keys(r.own)) {
      if (!r.params.includes(p)) {
        out.push(
          `${c.name}.${r.handler} (${r.path}) declares "${p}", which its path does not have`
        );
      }
    }
  }
  for (const p of Object.keys(c.declared)) {
    if (!c.routes.some((r) => r.params.includes(p))) {
      out.push(`${c.name} declares "${p}", which none of its routes has`);
    }
  }
  return out;
}

describe('path parameters are declared', () => {
  const controllers = controllersOf(AppModule).map(describeController);
  const withParams = controllers.filter((c) => c.routes.some((r) => r.params.length > 0));

  it('control: the walk finds the application, so an empty scan cannot pass', () => {
    expect(controllers.length).toBeGreaterThan(30);
    expect(withParams.map((c) => c.name)).toContain('AssociationsController');
    const associations = controllers.find((c) => c.name === 'AssociationsController')!;
    expect(associations.routes.filter((r) => r.params.includes('id')).length).toBeGreaterThan(80);
  });

  it('the application registers the guard that reads the declarations, globally', () => {
    const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppModule) ?? [];
    expect(providers).toContain(ROUTE_PARAMS_GUARD);
    expect(ROUTE_PARAMS_GUARD).toEqual({ provide: APP_GUARD, useClass: RouteParamsGuard });
  });

  it('every path parameter of a converted controller is declared, and every declaration names one', () => {
    const converted = withParams.filter((c) => !PENDING.has(c.name));
    expect(converted.map((c) => c.name)).toContain('AssociationsController');
    expect(converted.flatMap(faults)).toEqual([]);
  });

  it('a declaration anywhere, pending or not, never names a parameter its routes do not have', () => {
    const misnamed = controllers.flatMap(faults).filter((f) => !f.endsWith('is declared nowhere'));
    expect(misnamed).toEqual([]);
  });

  it('the pending list only shrinks: each name is a real controller that still has an undeclared parameter', () => {
    const stale = [...PENDING].filter((name) => {
      const c = withParams.find((x) => x.name === name);
      return !c || !faults(c).some((f) => f.endsWith('is declared nowhere'));
    });
    expect(stale).toEqual([]);
  });

  it('the checker itself refuses an undeclared parameter and a misnamed declaration', () => {
    const route = (own: RouteParamKinds): Route => ({
      handler: 'h',
      path: 'x/:id',
      params: ['id'],
      own,
    });
    expect(faults({ name: 'C', declared: {}, routes: [route({})] })).toHaveLength(1);
    expect(
      faults({ name: 'C', declared: { id: 'uuid' }, routes: [route({ idd: 'uuid' })] })
    ).toHaveLength(1);
    expect(
      faults({ name: 'C', declared: { id: 'uuid', other: 'opaque' }, routes: [route({})] })
    ).toHaveLength(1);
    expect(faults({ name: 'C', declared: { id: 'uuid' }, routes: [route({})] })).toEqual([]);
  });
});
