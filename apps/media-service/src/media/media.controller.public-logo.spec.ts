/// <reference types="jest" />

/**
 * `POST upload/public` (logos, avatars) decodes a member's image too, so it carries the same decode
 * bound as a form file: a few hundred kilobytes declaring tens of megapixels is a 422, never an
 * allocation of gigabytes in the process that serves every chat medium.
 */
import * as crypto from 'crypto';
import sharp from 'sharp';
import { UnprocessableEntityException } from '@nestjs/common';
import type { Request } from 'express';
import { MediaController } from './media.controller';
import { IMAGE_DECODE_MAX_PIXELS, MediaService } from './media.service';

const SECRET = 'test-secret';

function bearer(sub: string): Request {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub });
  const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return { headers: { authorization: `Bearer ${head}.${body}.${sig}` } } as unknown as Request;
}

function build() {
  const svc = Object.create(MediaService.prototype) as MediaService;
  const stored: Buffer[] = [];
  svc.uploadPublicAsset = jest.fn((data: Buffer) => {
    stored.push(data);
    return Promise.resolve('logo-id');
  });
  return { stored, controller: new MediaController(svc, {} as never, {} as never) };
}

const prevSecret = process.env.JWT_SECRET;
beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = prevSecret;
});

const asUpload = (buffer: Buffer) => ({ buffer, size: buffer.length, mimetype: 'image/jpeg' });

describe('POST upload/public: the decode is bounded', () => {
  it('stores an ordinary logo, resized', async () => {
    const { controller, stored } = build();
    const logo = await sharp({
      create: { width: 600, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    expect(await controller.uploadPublic(asUpload(logo), bearer('alice'))).toEqual({
      mediaId: 'logo-id',
    });
    const meta = await sharp(stored[0]).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 256, 128]);
  });

  it('refuses an image over IMAGE_DECODE_MAX_PIXELS with a 422 and stores nothing', async () => {
    const { controller, stored } = build();
    const side = Math.ceil(Math.sqrt(IMAGE_DECODE_MAX_PIXELS)) + 500;
    const huge = await sharp({
      create: { width: side, height: side, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .jpeg({ quality: 50 })
      .toBuffer();
    await expect(controller.uploadPublic(asUpload(huge), bearer('alice'))).rejects.toThrow(
      UnprocessableEntityException
    );
    expect(stored).toEqual([]);
  });
});
