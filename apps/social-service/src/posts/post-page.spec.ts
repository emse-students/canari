/// <reference types="jest" />
import 'reflect-metadata';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { ListPostsQueryDto, SearchPostsQueryDto } from './dto/post.dto';
import { PostsController } from './posts.controller';
import { POST_PAGE_MAX, postPageLimit } from './post-page';

/** The application's own pipe (`main.ts`), applied to a query string as Nest applies it. */
const pipe = new ValidationPipe({ whitelist: true, transform: true });
const read = <T>(metatype: new () => T, query: Record<string, string>): Promise<T> =>
  pipe.transform(query, { type: 'query', metatype }) as Promise<T>;

describe('the page of a list of posts', () => {
  it('serves the fallback when no size is asked, and never more than the ceiling', () => {
    expect(postPageLimit(undefined, 30)).toBe(30);
    expect(postPageLimit(10, 30)).toBe(10);
    expect(postPageLimit(POST_PAGE_MAX, 30)).toBe(POST_PAGE_MAX);
    expect(postPageLimit(100_000, 30)).toBe(POST_PAGE_MAX);
  });

  it.each([ListPostsQueryDto, SearchPostsQueryDto])(
    'reads whole numbers and refuses anything else with a 400 (%p)',
    async (dto) => {
      const page = await read(dto, { limit: '20', offset: '40' });
      expect([page.limit, page.offset]).toEqual([20, 40]);

      for (const query of [
        { limit: 'abc' },
        { limit: '0' },
        { limit: '-5' },
        { limit: '2.5' },
        { limit: '1e3x' },
        { offset: 'abc' },
        { offset: '-1' },
        { offset: '1.5' },
      ]) {
        await expect(read(dto, query)).rejects.toBeInstanceOf(BadRequestException);
      }
    }
  );

  describe('through the controller, as a plain member', () => {
    const service = { searchPosts: jest.fn(), listPosts: jest.fn() };
    // Only the two list handlers are called; nothing else of the controller is reached.
    const controller = new (PostsController as unknown as new (
      ...deps: unknown[]
    ) => PostsController)(service);

    beforeEach(() => jest.clearAllMocks());

    it('a search is served the largest page when more is asked, and 20 rows by default', async () => {
      await controller.searchPosts(
        await read(SearchPostsQueryDto, { q: 'gala', limit: '100000', offset: '3' }),
        'member-1'
      );
      expect(service.searchPosts).toHaveBeenLastCalledWith('gala', POST_PAGE_MAX, 3, {
        viewerUserId: 'member-1',
        isAdmin: false,
      });

      await controller.searchPosts(await read(SearchPostsQueryDto, { q: 'gala' }), 'member-1');
      expect(service.searchPosts).toHaveBeenLastCalledWith('gala', 20, 0, expect.anything());
    });

    it('a feed is served the largest page when more is asked, and 30 rows by default', async () => {
      await controller.listPosts(await read(ListPostsQueryDto, { limit: '100000' }), 'member-1');
      expect(service.listPosts).toHaveBeenLastCalledWith(
        expect.objectContaining({ limit: POST_PAGE_MAX, offset: 0 })
      );

      await controller.listPosts(await read(ListPostsQueryDto, {}), 'member-1');
      expect(service.listPosts).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 30 }));
    });
  });
});
