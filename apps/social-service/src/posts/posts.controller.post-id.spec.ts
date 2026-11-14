import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { routeParamKindsOf } from '../common/route-params';
import { PostsController } from './posts.controller';

/**
 * A post id that is not a UUID is a 400, never a 500.
 *
 * `posts.id` is a Postgres `uuid`, so an id like `reel-limits` - a newer client asking an older
 * server for a route it does not have, which lands on `GET :postId` - reached the query and came
 * back as `invalid input syntax for type uuid`, an unhandled `QueryFailedError` and a 500 (measured
 * on the local estate, 2026-10-02). `postId` is declared a uuid for every handler that takes one
 * (`@RouteParams`, read by the global guard), and this reads Nest's own route metadata so a handler
 * that declared it otherwise fails here.
 */
describe('PostsController post ids', () => {
  const handlers = Object.getOwnPropertyNames(PostsController.prototype).filter(
    (name) => name !== 'constructor'
  );

  it('declares every postId a uuid', () => {
    const reflector = new Reflector();
    const postIdParams: string[] = [];
    for (const handler of handlers) {
      const args: Record<string, { data?: unknown }> =
        Reflect.getMetadata(ROUTE_ARGS_METADATA, PostsController, handler) ?? {};
      if (!Object.values(args).some((arg) => arg.data === 'postId')) continue;
      postIdParams.push(handler);
      const fn = Reflect.get(PostsController.prototype, handler) as object;
      expect({ handler, kind: routeParamKindsOf(reflector, PostsController, fn).postId }).toEqual({
        handler,
        kind: 'uuid',
      });
    }
    // The control: the routes this is about do exist, so an empty scan cannot pass.
    expect(postIdParams.length).toBeGreaterThan(10);
  });
});
