import 'reflect-metadata';

import { readFileSync } from 'fs';
import { join } from 'path';

import { UnauthorizedException } from '@nestjs/common';

import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { ROUTE_PARAMS_KEY, type RouteParamKinds } from '../common/route-params';
import { FormsController } from './forms.controller';

/**
 * WHAT nginx's `auth_request` DOES NOT DO, ASSERTED ON THE ONE CONTROLLER THAT LEARNED IT.
 *
 * `/api/forms` carries `auth_request /internal/auth/verify`, and that check answers 200 for a
 * logged-OUT caller with `x-logged-in: false` so signed-out pages render. nginx grants on any 2xx,
 * so the edge IDENTIFIES and never refuses - only the service's own guard can. `GET :id` had no
 * guard, and on 2026-09-10 any form was readable by anybody who knew its id.
 *
 * The list of handlers is read from the prototype rather than typed out, because a route added
 * without a guard is exactly the case this test exists to catch and a hand-written list would not
 * contain it.
 */
describe('FormsController - auth_request identifies, the guard refuses', () => {
  const GUARD_METADATA = '__guards__';

  /**
   * Every handler on the controller. NONE IS EXEMPT since 2026-11-02: the one that was,
   * `getFormCalendarLink`, served an agenda entry the public showcase never shows
   * (docs/wiki/anonymous-surface.md). A guest answers a public form through `PublicFormsController`.
   */
  const mustBeGuarded = Object.getOwnPropertyNames(FormsController.prototype).filter(
    (name) => name !== 'constructor'
  );

  /** The guards Nest will run for `handler`, read from the metadata Nest itself reads. */
  function guardsOn(handler: string): unknown[] {
    const proto = FormsController.prototype as unknown as Record<string, unknown>;
    return (Reflect.getMetadata(GUARD_METADATA, proto[handler] as object) as unknown[]) ?? [];
  }

  it('has handlers to check at all', () => {
    // A prototype that reads as empty would make every assertion below vacuously true.
    expect(mustBeGuarded.length).toBeGreaterThan(5);
  });

  it.each(mustBeGuarded.map((h) => [h]))('%s runs NginxAuthGuard', (handler) => {
    expect(guardsOn(handler)).toContain(NginxAuthGuard);
  });

  it('guards the route that returns a form, which is the one that was open', () => {
    expect(guardsOn('get')).toContain(NginxAuthGuard);
  });

  it('guards the agenda link of a form, closed to a signed-out caller on 2026-11-02', () => {
    expect(guardsOn('getFormCalendarLink')).toContain(NginxAuthGuard);
  });

  it('refuses an anonymous agenda-link request at the guard, so the handler reads nothing', () => {
    // The guard runs before the handler: a request with no `X-User-Id` never reaches the read.
    const previous = process.env.INTERNAL_SHARED_SECRET;
    process.env.INTERNAL_SHARED_SECRET = 'secret-for-the-guard-test';
    try {
      const ctx = {
        switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
      } as never;
      expect(() => new NginxAuthGuard().canActivate(ctx)).toThrow(UnauthorizedException);
    } finally {
      if (previous === undefined) delete process.env.INTERNAL_SHARED_SECRET;
      else process.env.INTERNAL_SHARED_SECRET = previous;
    }
  });
});

/**
 * EVERY FORM ID IS VALIDATED BEFORE THE DATABASE IS ASKED ANYTHING.
 *
 * The columns are `uuid`, so an id that is not one reached Postgres and came back as a 500 - a
 * promise that the server is broken, for a request that was merely malformed. The class declares
 * its path parameters uuids (`@RouteParams`, read by the global guard before any other guard), and
 * `route-params.coverage.spec.ts` fails on a route parameter no declaration names. What is held
 * HERE is that this controller has no parameter of another kind: a route added tomorrow with an
 * `opaque` one fails, and whoever adds it says why a form route takes something else than a uuid.
 */
describe('FormsController - ids are validated at the boundary', () => {
  const source = readFileSync(join(__dirname, 'forms.controller.ts'), 'utf8');
  const params = [...source.matchAll(/@Param\((['"])(\w+)\1/g)].map((m) => m[2]);
  const declared = (Reflect.getMetadata(ROUTE_PARAMS_KEY, FormsController) ??
    {}) as RouteParamKinds;

  it('finds the parameters it is meant to be checking', () => {
    expect(params.length).toBeGreaterThan(15);
  });

  it('declares every path parameter of the class a uuid', () => {
    expect(Object.keys(declared).sort()).toEqual(['fileId', 'id', 'submissionId']);
    expect([...new Set(Object.values(declared))]).toEqual(['uuid']);
  });

  it('no handler declares a kind of its own, and no @Param names anything else', () => {
    expect([...new Set(params)].filter((name) => declared[name] !== 'uuid')).toEqual([]);
    const own = Object.getOwnPropertyNames(FormsController.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        Reflect.getMetadata(
          ROUTE_PARAMS_KEY,
          Reflect.get(FormsController.prototype, name) as object
        ) !== undefined
    );
    expect(own).toEqual([]);
  });
});

/**
 * A FORM'S AGENDA LINK ANSWERS WHAT ITS READ ANSWERS (2026-11-14): a form the reader may not read -
 * a draft, one of an archived association - answers no link, exactly as an absent form, and the
 * agenda is not even asked; a form they may read is looked up as before.
 */
describe('FormsController - the agenda link follows the form read', () => {
  function controllerWith(mayRead: boolean) {
    const findCalendarEventByLinkedForm = jest.fn(async () => null);
    const controller = new FormsController(
      { mayRead: jest.fn(async () => mayRead) } as never,
      { findCalendarEventByLinkedForm } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    return { controller, findCalendarEventByLinkedForm };
  }

  it('answers no link, and asks nothing, for a form the reader may not read', async () => {
    const { controller, findCalendarEventByLinkedForm } = controllerWith(false);
    await expect(controller.getFormCalendarLink('f1', 'u1')).resolves.toEqual({
      linkedEvent: null,
    });
    expect(findCalendarEventByLinkedForm).not.toHaveBeenCalled();
  });

  it('looks the link up for a form the reader may read', async () => {
    const { controller, findCalendarEventByLinkedForm } = controllerWith(true);
    await controller.getFormCalendarLink('f1', 'u1', 'false');
    expect(findCalendarEventByLinkedForm).toHaveBeenCalledWith('f1', {
      userId: 'u1',
      isGlobalAdmin: false,
    });
  });
});
