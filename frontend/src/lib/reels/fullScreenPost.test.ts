/**
 * Which rows the CanaReels viewer draws as a full-screen page. The cases are the server's
 * (`apps/social-service/src/posts/full-screen-post-sql.integration.spec.ts`), so the client and the
 * SQL read one row the same way.
 */
import { describe, expect, it } from 'vitest';
import type { PostEntity, PostMediaRef } from '$lib/posts/api';
import { fullScreenMediaOf, fullScreenPageOf } from './fullScreenPost';

const picture = { type: 'image', mediaId: 'p', mimeType: 'image/webp' } as PostMediaRef;
const video = { type: 'video', mediaId: 'v', mimeType: 'video/mp4' } as PostMediaRef;

function post(fields: Partial<PostEntity>): PostEntity {
  return { kind: 'post', media: [], polls: [], ...fields } as PostEntity;
}

describe('fullScreenPageOf', () => {
  it('draws a reel as a reel page', () => {
    expect(fullScreenPageOf(post({ kind: 'reel', media: [video] }))).toBe('reel');
  });

  it('draws a post of exactly one picture as a photo page', () => {
    expect(fullScreenPageOf(post({ media: [picture] }))).toBe('photo');
  });

  it("reads a legacy row's picture from its mime type", () => {
    const legacy = { mediaId: 'l', mimeType: 'image/jpeg' } as PostMediaRef;
    expect(fullScreenPageOf(post({ media: [legacy] }))).toBe('photo');
  });

  it('keeps a picture with a caption that carries no link', () => {
    expect(fullScreenPageOf(post({ media: [picture], markdown: 'Soiree au foyer' }))).toBe('photo');
  });

  it('draws a post of exactly one video, outside a reel, as a reel page', () => {
    expect(fullScreenPageOf(post({ media: [video] }))).toBe('reel');
  });

  it("reads a legacy row's video from its mime type", () => {
    const legacy = { mediaId: 'l', mimeType: 'video/quicktime' } as PostMediaRef;
    expect(fullScreenPageOf(post({ media: [legacy] }))).toBe('reel');
  });

  it('keeps a video with a caption that carries no link, and never reads an expiry', () => {
    const plain = post({ media: [video], markdown: 'Soiree au foyer' });
    expect(plain.expiresAt).toBeUndefined();
    expect(fullScreenPageOf(plain)).toBe('reel');
  });

  it('reads `images` from a server older than the rename', () => {
    expect(fullScreenPageOf(post({ media: undefined, images: [picture] }))).toBe('photo');
  });

  it.each([
    ['a video and a picture', { media: [video, picture] }],
    ['two videos', { media: [video, video] }],
    ['a video with a poll', { media: [video], polls: [{ id: 'q' }] as PostEntity['polls'] }],
    ['a video with an attached form', { media: [video], attachedFormId: 'form-1' }],
    ['a video with a linked event', { media: [video], linkedCalendarEventId: 'ev-1' }],
    ['a video with a link in its text', { media: [video], markdown: 'voir https://example.org' }],
    ['two pictures', { media: [picture, picture] }],
    [
      'a file',
      { media: [{ type: 'file', mediaId: 'f', mimeType: 'application/pdf' } as PostMediaRef] },
    ],
    ['text alone', { media: [] }],
    ['a picture with a poll', { media: [picture], polls: [{ id: 'q' }] as PostEntity['polls'] }],
    ['a picture with a form', { media: [picture], forms: [{ id: 'f' }] as PostEntity['forms'] }],
    ['a picture with an attached form', { media: [picture], attachedFormId: 'form-1' }],
    ['a picture with a linked event', { media: [picture], linkedCalendarEventId: 'ev-1' }],
    [
      'a picture with a link in its text',
      { media: [picture], markdown: 'voir https://example.org' },
    ],
  ])('keeps %s out', (_label, fields) => {
    expect(fullScreenPageOf(post(fields as Partial<PostEntity>))).toBeNull();
  });
});

describe('fullScreenMediaOf', () => {
  it('is the one attachment', () => {
    expect(fullScreenMediaOf(post({ media: [picture] }))).toBe(picture);
  });
});

describe('fullScreenMediaOf for a post of one video', () => {
  it('is the video, which the save button reads from `media[0]`', () => {
    expect(fullScreenMediaOf(post({ media: [video] }))).toBe(video);
  });
});
