/**
 * `GET /api/posts` after the CanaReels switches collapsed (2026-11-11): a floor client may still
 * send `singlePhotos`, `singleMedia` and `withLinks`. The app's global pipe (`main.ts`,
 * `whitelist: true, transform: true`) must STRIP them - a 400 would cost that client its list
 * (docs/wiki/legacy-compatibility.md).
 */
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ListPostsQueryDto } from './post.dto';

const pipe = new ValidationPipe({ whitelist: true, transform: true });

const transform = (query: Record<string, string>) =>
  pipe.transform(query, { type: 'query', metatype: ListPostsQueryDto }) as Promise<
    Record<string, unknown>
  >;

describe('ListPostsQueryDto through the global pipe', () => {
  it('strips the retired switches instead of refusing them, and keeps multiMedia', async () => {
    const out = await transform({
      kind: 'reel',
      multiMedia: 'true',
      singlePhotos: 'true',
      singleMedia: 'true',
      withLinks: 'true',
    });
    expect(out).toBeInstanceOf(ListPostsQueryDto);
    expect(out.kind).toBe('reel');
    expect(out.multiMedia).toBe(true);
    expect(out).not.toHaveProperty('singlePhotos');
    expect(out).not.toHaveProperty('singleMedia');
    expect(out).not.toHaveProperty('withLinks');
  });

  it('a pre-multiMedia query (singlePhotos alone) passes, with no full-screen switch on', async () => {
    const out = await transform({ kind: 'reel', singlePhotos: 'true' });
    expect(out.kind).toBe('reel');
    expect(out.multiMedia).toBeUndefined();
    expect(out).not.toHaveProperty('singlePhotos');
  });
});
