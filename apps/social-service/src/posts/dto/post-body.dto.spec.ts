import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreatePostDto, UpdatePostDto } from './post.dto';

/**
 * A post needs a body OR a media entry, on create and on edit - the composer's own rule
 * (`hasContent`). A captionless video used to be uploaded whole and then refused here.
 */
const MEDIA = {
  type: 'video',
  mediaId: 'm1',
  key: 'ab',
  iv: 'cd',
  mimeType: 'video/mp4; codecs="avc1.64001f, mp4a.40.2"',
  size: 10,
};

const errorsOn = (cls: typeof CreatePostDto | typeof UpdatePostDto, body: object) =>
  validateSync(plainToInstance(cls, body), { whitelist: true }).map((e) => e.property);

describe.each([
  ['CreatePostDto', CreatePostDto],
  ['UpdatePostDto', UpdatePostDto],
])('%s.markdown', (_name, cls) => {
  it('accepts a video with no caption', () => {
    expect(errorsOn(cls, { markdown: '', media: [MEDIA] })).toEqual([]);
  });

  it('accepts a captionless entry sent by an old client under `images`', () => {
    expect(errorsOn(cls, { markdown: '', images: [MEDIA] })).toEqual([]);
  });

  it('accepts a body with no media', () => {
    expect(errorsOn(cls, { markdown: 'hello' })).toEqual([]);
  });

  it('refuses a post with neither', () => {
    expect(errorsOn(cls, { markdown: '' })).toEqual(['markdown']);
    expect(errorsOn(cls, { markdown: '', media: [] })).toEqual(['markdown']);
  });

  it('counts whitespace as no body, as the composer does', () => {
    expect(errorsOn(cls, { markdown: '  \n ' })).toEqual(['markdown']);
  });

  it('still refuses a body that is not a string', () => {
    expect(errorsOn(cls, { markdown: 42, media: [MEDIA] })).toEqual(['markdown']);
  });
});
