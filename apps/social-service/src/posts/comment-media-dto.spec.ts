import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddCommentDto, COMMENT_MEDIA_MAX_BYTES } from './dto/post.dto';

/**
 * A comment's ONE picture is validated like a post's media, and narrower: an image, bounded, with
 * no segmented encoding. It was an unchecked object, so a crafted request stored any shape.
 */
const media = {
  mediaId: 'b3c1f0aa-0000-4000-8000-000000000001',
  key: 'a2V5',
  iv: 'aXY=',
  mimeType: 'image/jpeg',
  size: 120_000,
  width: 800,
  height: 600,
};

const check = (body: object) => validate(plainToInstance(AddCommentDto, body));

describe('AddCommentDto.media', () => {
  it('accepts the ref the composer sends (no `type`), with or without text', async () => {
    expect(await check({ media })).toHaveLength(0);
    expect(await check({ text: 'nice', media })).toHaveLength(0);
    expect(await check({ media: { ...media, mimeType: 'image/gif' } })).toHaveLength(0);
  });

  it('accepts an explicit type of image, and a comment with no media at all', async () => {
    expect(await check({ media: { ...media, type: 'image' } })).toHaveLength(0);
    expect(await check({ text: 'plain' })).toHaveLength(0);
  });

  it.each([
    ['a video type', { type: 'video' }],
    ['a file type', { type: 'file' }],
    ['a non-image mime type', { mimeType: 'video/mp4' }],
    ['a mime type that only starts like one', { mimeType: 'application/image/x' }],
    ['a size over the ceiling', { size: COMMENT_MEDIA_MAX_BYTES + 1 }],
    ['a zero size', { size: 0 }],
    ['a missing media id', { mediaId: '' }],
    ['a missing key', { key: undefined }],
    ['an oversized iv', { iv: 'x'.repeat(65) }],
    ['a non-integer width', { width: 1.5 }],
    ['an absurd height', { height: 1_000_000 }],
    ['a placeholder that is not base64', { placeholder: '<script>' }],
  ])('refuses %s', async (_name, patch) => {
    expect(await check({ media: { ...media, ...patch } })).not.toHaveLength(0);
  });

  it('refuses media that is not an object', async () => {
    expect(await check({ media: 'x' })).not.toHaveLength(0);
    expect(await check({ media: [media] })).not.toHaveLength(0);
  });

  it('keeps the dimensions it was given', () => {
    expect(plainToInstance(AddCommentDto, { media }).media?.width).toBe(800);
  });
});
