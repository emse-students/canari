/// <reference types="jest" />

/**
 * The chunk routes' owner checks as the CONTROLLER serves them: `DELETE upload/chunk/:id` answers
 * 204 for its opener and 403 for another member, and `POST upload/chunk/:id` refuses a member who is
 * not the opener (WP-OFF-8 review 4). A real JWT, a real service over the real chunk directory.
 */
import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

const SECRET = 'test-secret';

function token(sub: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub });
  const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
const req = (sub: string) =>
  ({ headers: { authorization: `Bearer ${token(sub)}` } }) as unknown as Request;

function build() {
  const svc = Object.create(MediaService.prototype) as MediaService;
  Object.assign(svc, { uploadLocks: new Map(), logger: { log: jest.fn(), warn: jest.fn() } });
  return { svc, controller: new MediaController(svc) };
}

let staged = '';
const prevSecret = process.env.JWT_SECRET;
beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = prevSecret;
});
afterEach(async () => {
  if (staged) await fs.remove(staged);
  staged = '';
});

async function open(svc: MediaService) {
  const id = await svc.initChunkedUpload('alice', undefined, undefined, 1e8);
  staged = (svc as unknown as { chunkTempPath: (i: string) => string }).chunkTempPath(id);
  return id;
}

describe('DELETE upload/chunk/:id', () => {
  it('is declared as a 204', () => {
    expect(Reflect.getMetadata('__httpCode__', MediaController.prototype.abortChunkedUpload)).toBe(
      204
    );
  });

  it('the opener gets a void answer and the staging is gone; a repeat is also fine', async () => {
    const { svc, controller } = build();
    const id = await open(svc);
    await expect(controller.abortChunkedUpload(id, req('alice'))).resolves.toBeUndefined();
    expect(await fs.pathExists(staged)).toBe(false);
    await expect(controller.abortChunkedUpload(id, req('alice'))).resolves.toBeUndefined();
  });

  it('another member gets a 403 and the staging stays', async () => {
    const { svc, controller } = build();
    const id = await open(svc);
    await expect(controller.abortChunkedUpload(id, req('mallory'))).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(await fs.pathExists(staged)).toBe(true);
  });
});

describe('POST upload/chunk/:id', () => {
  const file = { buffer: Buffer.from('abc'), mimetype: 'application/octet-stream', size: 3 };

  it('another member gets a 403 and nothing is appended', async () => {
    const { svc, controller } = build();
    const id = await open(svc);
    await expect(controller.appendChunk(id, file, req('mallory'))).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect((await fs.stat(staged)).size).toBe(0);
  });

  it('the opener appends', async () => {
    const { svc, controller } = build();
    const id = await open(svc);
    await expect(controller.appendChunk(id, file, req('alice'))).resolves.toEqual({ ok: true });
    expect((await fs.stat(staged)).size).toBe(3);
  });
});
