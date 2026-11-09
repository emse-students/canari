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

describe('PostMediaDto.placeholder', () => {
  it('keeps a reel first frame ThumbHash through the whitelist', () => {
    const dto = plainToInstance(PostMediaDto, {
      ...MEDIA,
      placeholder: 'YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw==',
    });
    expect(validateSync(dto, { whitelist: true })).toEqual([]);
    expect(dto.placeholder).toBe('YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw==');
  });

  it('refuses a value that is not base64 - markup or a URL is never painted as a picture', () => {
    for (const bad of ['<svg onload=x>', 'data:image/png;base64,AA==', 'AA==AA']) {
      expect(validate({ ...MEDIA, placeholder: bad }).map((e) => e.property)).toEqual([
        'placeholder',
      ]);
    }
  });

  it('refuses a value too long to be a ThumbHash', () => {
    expect(validate({ ...MEDIA, placeholder: 'a'.repeat(129) }).map((e) => e.property)).toEqual([
      'placeholder',
    ]);
  });
});
