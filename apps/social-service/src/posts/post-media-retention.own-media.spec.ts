/**
 * A comment or a post may cite only pictures its writer uploaded: ids are not secrets, and deleting
 * a citing row releases the blob it names, so a foreign id would let its citer get it swept.
 */
import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { PostMediaRetentionService } from './post-media-retention.service';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeService(answer: () => unknown) {
  const post = jest.fn((..._args: unknown[]) => answer());
  const service = new PostMediaRetentionService({ post } as never, {} as never);
  return { service, post };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('PostMediaRetentionService.assertOwnMedia', () => {
  it('asks the media service nothing for a row with no picture', async () => {
    const { service, post } = makeService(() => of({ data: { owned: [], refused: [] } }));
    await service.assertOwnMedia('alice', [], 'comment');
    expect(post).not.toHaveBeenCalled();
  });

  it("passes when every id is the writer's own, asking read-only for that writer", async () => {
    const { service, post } = makeService(() => of({ data: { owned: [A], refused: [] } }));
    await expect(service.assertOwnMedia('alice', [A], 'comment')).resolves.toBeUndefined();
    expect(post.mock.calls[0][0]).toMatch(/media\/internal\/owned$/);
    expect(post.mock.calls[0][1]).toEqual({ mediaIds: [A], ownerId: 'alice' });
  });

  it("refuses with a 400 as soon as one id is not the writer's", async () => {
    const { service } = makeService(() => of({ data: { owned: [A], refused: [B] } }));
    await expect(service.assertOwnMedia('alice', [A, B], 'post')).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('answers 503 when the media service cannot say - never stored on trust', async () => {
    const { service } = makeService(() => throwError(() => new Error('ECONNRESET')));
    await expect(service.assertOwnMedia('alice', [A], 'comment')).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });
});
