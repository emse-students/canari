import { ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InternalController } from './internal.controller';
import type { Post as PostEntity } from '../posts/entities/post.entity';

/**
 * `GET internal/users/:userId/holdings` is what core-service shows an admin before merging an Alumni
 * duplicate, which erases the account (D48): counts only, each one what the erasure would take.
 */
describe('InternalController.userHoldings', () => {
  const counts = { personalPosts: 3, associations: 1, communities: 2, formSubmissions: 0 };
  const query = jest.fn(async () => [counts]);
  const controller = new InternalController(
    { manager: { query } } as unknown as Repository<PostEntity>,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );

  beforeEach(() => {
    process.env.INTERNAL_SECRET = 'shared-secret';
    query.mockClear();
  });

  it('answers the four counts for the account, in one read', async () => {
    await expect(controller.userHoldings('u-1', 'shared-secret')).resolves.toEqual(counts);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual(['u-1']);
    // A post published AS an association stays after an erasure: it is not counted as lost.
    expect(sql).toContain('"associationId" IS NULL');
  });

  it('refuses a caller without the internal secret, reading nothing', async () => {
    await expect(controller.userHoldings('u-1', 'wrong')).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(query).not.toHaveBeenCalled();
  });
});
