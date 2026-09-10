import 'reflect-metadata';

import { readFileSync } from 'fs';
import { join } from 'path';

import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
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
   * The routes that are meant to answer anybody, each with the reason.
   *
   * It is a map rather than a set so the reason lives next to the exemption: an exemption with no
   * reason is indistinguishable from an oversight, which is what the whole audit was about.
   */
  const PUBLIC_BY_INTENT: Record<string, string> = {
    getFormCalendarLink:
      'read by the public association page for a signed-out visitor; answers one agenda entry and never the form contents',
  };

  /** Every handler on the controller, split by whether it claims an exemption. */
  const handlers = Object.getOwnPropertyNames(FormsController.prototype).filter(
    (name) => name !== 'constructor'
  );
  const mustBeGuarded = handlers.filter((h) => !PUBLIC_BY_INTENT[h]);
  const exempt = handlers.filter((h) => PUBLIC_BY_INTENT[h]);

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

  it.each(exempt.map((h) => [h]))('%s is exempt, and says why', (handler) => {
    // An exemption with no reason is indistinguishable from an oversight, which is the whole of
    // what this audit found - so the reason is asserted, not just the exemption.
    expect(PUBLIC_BY_INTENT[handler].length).toBeGreaterThan(20);
  });

  it('guards the route that returns a form, which is the one that was open', () => {
    expect(guardsOn('get')).toContain(NginxAuthGuard);
  });

  it('leaves the public agenda link reachable without a session', () => {
    expect(guardsOn('getFormCalendarLink')).not.toContain(NginxAuthGuard);
  });
});

/**
 * EVERY FORM ID IS VALIDATED BEFORE THE DATABASE IS ASKED ANYTHING.
 *
 * The columns are `uuid`, so an id that is not one reached Postgres and came back as a 500 - a
 * promise that the server is broken, for a request that was merely malformed. Asserted against the
 * SOURCE rather than through the framework, because what has to hold is a property of the file: a
 * route added tomorrow without the pipe is the case this exists to catch, and it would satisfy any
 * test written against today's handlers.
 */
describe('FormsController - ids are validated at the boundary', () => {
  const source = readFileSync(join(__dirname, 'forms.controller.ts'), 'utf8');
  const params = [...source.matchAll(/@Param\((['"])(\w+)\1([^)]*)\)/g)];

  it('finds the parameters it is meant to be checking', () => {
    expect(params.length).toBeGreaterThan(15);
  });

  it.each(params.map((m) => [m[2], m[3]]))('@Param(%s) parses as a UUID', (_name, rest) => {
    expect(rest).toContain('ParseUUIDPipe');
  });
});
