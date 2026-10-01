import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PostMediaDto } from './post.dto';

/**
 * A post media entry's `encoding` (CanaReels R2) must SURVIVE the global `whitelist: true` pipe.
 *
 * The reader release declares it before any client writes it: a segmented blob saved without the
 * field would be read by every client as a single AES-GCM block and refused - the video lost at
 * the first save. The pipe strips what no decorator declares, so the decorator IS the guarantee.
 */
const MEDIA = {
  type: 'video',
  mediaId: 'm1',
  key: 'ab',
  iv: 'cd',
  mimeType: 'video/mp4',
  size: 10,
};

const validate = (body: object) =>
  validateSync(plainToInstance(PostMediaDto, body), { whitelist: true, forbidUnknownValues: true });

describe('PostMediaDto.encoding', () => {
  it('keeps a segmented entry through the whitelist', () => {
    const dto = plainToInstance(PostMediaDto, { ...MEDIA, encoding: 'segmented-v1' });
    expect(validateSync(dto, { whitelist: true })).toEqual([]);
    expect(dto.encoding).toBe('segmented-v1');
  });

  it('accepts an entry with no encoding - every post written before it', () => {
    expect(validate(MEDIA)).toEqual([]);
  });

  it('refuses a format no client knows rather than storing it', () => {
    expect(validate({ ...MEDIA, encoding: 'segmented-v9' }).map((e) => e.property)).toEqual([
      'encoding',
    ]);
  });
});
