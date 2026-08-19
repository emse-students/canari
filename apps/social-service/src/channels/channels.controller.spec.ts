import { ChannelsController } from './channels.controller';

/**
 * The paths this controller actually registers - not the ones its decorators look like they say.
 *
 * WRITTEN AFTER A 404 THAT SHIPPED. `@Controller('channels')` already contributes the first
 * segment, so `@Get('channels/:channelId/distribution-group')` registers
 * `/channels/channels/:channelId/...`. Nothing about that is a type error, nothing about it is a
 * lint error, and every unit test of the SERVICE passed - the service method was correct and
 * reachable by no URL. It took a private salon on production answering 404 to the one client that
 * needed it, which is precisely the shape CLAUDE.md names: a green gate is not a working system,
 * and everything verified by COMPILING proves nothing about running.
 *
 * So this file asserts the composed path, character for character, from the metadata Nest itself
 * will read at bootstrap. It is the cheapest possible substitute for a request.
 */

/** Nest's own metadata keys - imported by value rather than re-spelt, so a rename breaks here. */
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

/** The verbs, in `RequestMethod`'s own order. */
const VERBS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/** The controller's own prefix, read from the class rather than assumed. */
const PREFIX = Reflect.getMetadata(PATH_METADATA, ChannelsController) as string;

/** Every handler on the controller as `VERB /prefix/path`, which is what a client has to hit. */
function routes(): string[] {
  const proto = ChannelsController.prototype as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => proto[name])
    .filter((fn): fn is (...args: unknown[]) => unknown => typeof fn === 'function')
    .filter((fn) => Reflect.getMetadata(PATH_METADATA, fn) !== undefined)
    .map((fn) => {
      const path = Reflect.getMetadata(PATH_METADATA, fn) as string;
      const verb = VERBS[Reflect.getMetadata(METHOD_METADATA, fn) as number] ?? '?';
      return `${verb} /${PREFIX}${path === '/' ? '' : `/${path}`}`;
    });
}

describe('ChannelsController routing', () => {
  it('never repeats its own prefix in a handler path', () => {
    // The defect class, stated once rather than per route: the prefix is contributed by the
    // @Controller decorator, so any handler that names it again is registered one segment too deep
    // and answers 404 to the URL its author meant to write.
    const doubled = routes().filter((r) => r.includes(`/${PREFIX}/${PREFIX}/`));
    expect(doubled).toEqual([]);
  });

  it.each([
    'GET /channels/:channelId/distribution-group',
    'POST /channels/:channelId/distribution-group/group-info',
    'POST /channels/:channelId/join-as-admin',
    'GET /channels/workspaces/:workspaceId/distribution-group',
    'POST /channels/workspaces/:workspaceId/distribution-group/group-info',
  ])('registers %s, which the Graine client calls by that exact path', (route) => {
    // The five routes a device needs to be handed the seeds of a scope it may read. They are named
    // literally because the client names them literally: `ChannelService.distributionGroupUrl` in
    // the frontend builds these strings, and no compiler relates the two sides.
    expect(routes()).toContain(route);
  });

  it('declares the salon route before the catch-all channel routes it could be shadowed by', () => {
    // Nest matches in declaration order, so `:channelId/distribution-group` has to be declared
    // before anything that could swallow it. Nothing does today; this fails the day one is added
    // above it, which is the only warning there would be.
    const all = routes();
    const salon = all.indexOf('GET /channels/:channelId/distribution-group');
    const catchAll = all.indexOf('GET /channels/:channelId/messages');
    expect(salon).toBeGreaterThanOrEqual(0);
    expect(catchAll).toBeGreaterThan(salon);
  });
});
