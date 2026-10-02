import { ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { PostsController } from './posts.controller';

/**
 * A post id that is not a UUID is a 400, never a 500.
 *
 * `posts.id` is a Postgres `uuid`, so an id like `reel-limits` - a newer client asking an older
 * server for a route it does not have, which lands on `GET :postId` - reached the query and came
 * back as `invalid input syntax for type uuid`, an unhandled `QueryFailedError` and a 500 (measured
 * on the local estate, 2026-10-02). Every `postId` parameter goes through `ParseUUIDPipe`, and this
 * reads Nest's own route metadata so a handler added later without it fails here.
 */
describe('PostsController post ids', () => {
  const handlers = Object.getOwnPropertyNames(PostsController.prototype).filter(
    (name) => name !== 'constructor'
  );

  it('parses every postId as a UUID', () => {
    const postIdParams: string[] = [];
    for (const handler of handlers) {
      const args: Record<string, { data?: unknown; pipes?: unknown[] }> =
        Reflect.getMetadata(ROUTE_ARGS_METADATA, PostsController, handler) ?? {};
      for (const arg of Object.values(args)) {
        if (arg.data !== 'postId') continue;
        postIdParams.push(handler);
        expect({ handler, piped: (arg.pipes ?? []).includes(ParseUUIDPipe) }).toEqual({
          handler,
          piped: true,
        });
      }
    }
    // The control: the routes this is about do exist, so an empty scan cannot pass.
    expect(postIdParams.length).toBeGreaterThan(10);
  });
});
