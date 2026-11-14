import { ParseUUIDPipe } from '@nestjs/common';
import { MODULE_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { APP_GUARD } from '@nestjs/core';
import { AppModule } from './app.module';
import { ROUTE_PARAMS_GUARD, ROUTE_PARAMS_KEY, RouteParamsGuard } from './common/route-params';
import type { RouteParamKinds } from './common/route-params';

/**
 * EVERY PATH PARAMETER OF EVERY CONTROLLER IS DECLARED, AND EVERY DECLARATION NAMES A REAL ONE
 * (docs/wiki/services/social-service.md, "Path parameters are declared").
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

/**
 * The path parameters of a class that still carry a `ParseUUIDPipe`, as `Class.handler(:name)`.
 * Read from Nest's own argument metadata, so a pipe passed as a class or as an instance is found.
 */
function pipedPathParams(cls: Ctor): string[] {
  const out: string[] = [];
  for (const handler of Object.getOwnPropertyNames(cls.prototype)) {
    const args: Record<string, { data?: unknown; pipes?: unknown[] }> =
      Reflect.getMetadata(ROUTE_ARGS_METADATA, cls, handler) ?? {};
    for (const [key, arg] of Object.entries(args)) {
      if (!key.startsWith(`${RouteParamtypes.PARAM}:`)) continue;
      const piped = (arg.pipes ?? []).some(
        (x) => x === ParseUUIDPipe || x instanceof ParseUUIDPipe
      );
      if (piped) out.push(`${cls.name}.${handler}(:${String(arg.data)})`);
    }
  }
  return out;
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
  const classes = controllersOf(AppModule);
  const controllers = classes.map(describeController);
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

  it('every path parameter of every controller is declared, and every declaration names one', () => {
    expect(withParams.length).toBeGreaterThan(30);
    expect(controllers.flatMap(faults)).toEqual([]);
  });

  it('no path parameter carries a uuid pipe: the declaration is the one mechanism', () => {
    class Piped {
      one(_a: string, _b: string) {}
    }
    const args = {
      [`${RouteParamtypes.PARAM}:0`]: { data: 'id', pipes: [ParseUUIDPipe] },
      [`${RouteParamtypes.PARAM}:1`]: { data: 'other', pipes: [new ParseUUIDPipe()] },
      [`${RouteParamtypes.QUERY}:2`]: { data: 'q', pipes: [ParseUUIDPipe] },
    };
    Reflect.defineMetadata(ROUTE_ARGS_METADATA, args, Piped, 'one');
    // The control: the reader finds a pipe on a path parameter, in either spelling, and only there.
    expect(pipedPathParams(Piped)).toEqual(['Piped.one(:id)', 'Piped.one(:other)']);
    expect(classes.flatMap(pipedPathParams)).toEqual([]);
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
