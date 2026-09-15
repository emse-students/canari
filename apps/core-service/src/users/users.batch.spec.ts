import { BadRequestException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import type { AvatarService } from './avatar.service';
import type { UserBlocksService } from './user-blocks.service';
import { User } from './entities/user.entity';

/**
 * `GET /users/batch`, AND THE TWO THINGS THAT WOULD SILENTLY UNDO IT.
 *
 * The route exists so a client that knows twenty ids at once asks once instead of twenty times
 * (measured on production 2026-09-15: 20 requests, 140-253 ms each). Two properties carry that, and
 * neither is visible from a happy-path call:
 *
 *   - the list is BOUNDED, by a refusal rather than a truncation - an answer quietly missing its
 *     tail looks exactly like a page of deleted accounts, and nothing downstream could tell;
 *   - an id that matches nothing is ABSENT from the answer rather than an error, so one deleted
 *     account cannot refuse the nineteen live ones beside it.
 *
 * The declaration-order trap (`batch` must come before `:id`, or Nest routes it as `id = "batch"`)
 * is not testable from here - it is a property of the metadata, not of these methods - and is
 * asserted by the route list in `users.controller.ts` itself.
 */
describe('GET /users/batch', () => {
  function makeController(rows: User[]) {
    const find = jest.fn().mockResolvedValue(rows);
    const userRepository = { find } as unknown as Repository<User>;
    const blocks = {
      deleteAllFor: jest.fn(),
      invisibleUserIdsFor: jest.fn().mockResolvedValue([]),
    } as unknown as UserBlocksService;
    const service = new UsersService(userRepository, {} as DataSource, blocks);
    const controller = new UsersController(service, {} as AvatarService, blocks);
    return { controller, find };
  }

  const row = (id: string) => ({ id, firstName: 'A', lastName: 'B' }) as User;

  it('answers every id in one query', async () => {
    const { controller, find } = makeController([row('a'), row('b')]);

    const { users } = await controller.findMany('a,b');

    expect(users.map((u) => u.id)).toEqual(['a', 'b']);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('omits an id that matches nothing rather than refusing the whole request', async () => {
    const { controller } = makeController([row('alive')]);

    const { users } = await controller.findMany('alive,gone');

    // The caller reads the absence and classifies it, exactly as it classifies the 404 from `:id`.
    expect(users.map((u) => u.id)).toEqual(['alive']);
  });

  it('asks for each id once, however many times it was listed', async () => {
    const { controller, find } = makeController([row('a')]);

    await controller.findMany(' a , a ,a,');

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: expect.anything() } })
    );
    const where = find.mock.calls[0][0].where as { id: { _value: string[] } };
    expect(where.id._value).toEqual(['a']);
  });

  it('REFUSES a list longer than the cap instead of answering a truncated one', async () => {
    const { controller, find } = makeController([]);

    const ids = Array.from({ length: 101 }, (_, i) => `u${i}`).join(',');

    await expect(controller.findMany(ids)).rejects.toBeInstanceOf(BadRequestException);
    expect(find).not.toHaveBeenCalled();
  });

  it('never reaches the database for a param Express handed over as an array', async () => {
    // `ids` is TYPED string and Express can still produce an array (`?ids=a&ids=b`) or an object -
    // the same runtime type confusion `search` re-checks for, and here the value flows into an
    // `IN (...)`.
    const { controller, find } = makeController([]);

    await expect(controller.findMany(['a', 'b'] as unknown as string)).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(controller.findMany({ x: 1 } as unknown as string)).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(find).not.toHaveBeenCalled();
  });

  it('never reaches the database for an empty list', async () => {
    const { controller, find } = makeController([]);

    const { users } = await controller.findMany('');

    expect(users).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
});
