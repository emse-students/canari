/// <reference types="jest" />

/**
 * THE LEGACY CHUNK SESSION'S LIFECYCLE: a client can abandon its own session, and a `complete` asked
 * twice answers with the same object (WP-OFF-8 review, 2026-10-10).
 *
 * WHY. The client restarts a failed upload under a NEW uploadId, so every stall, cancel or refusal at
 * chunk N stranded up to N x 8 MiB on disk for the 24 h sweep. And `complete` streams up to 100 MB to
 * storage with no byte moving on the wire: a client that stopped waiting and asked again must get the
 * SAME mediaId back, never a second stored copy. Real filesystem under `chunks_temp`, mocked storage.
 */
import * as fs from 'fs-extra';
import { ForbiddenException } from '@nestjs/common';
import { MediaService } from './media.service';

const OWNER = 'owner-1';
const SECOND_FILE = Buffer.alloc(1024, 7);

type Internals = {
  uploadLocks: Map<string, Promise<void>>;
  logger: { log: jest.Mock; warn: jest.Mock };
  storage: { putFileStream: jest.Mock };
  setAccess: jest.Mock;
  persistMetadata: jest.Mock;
  chunkTempPath: (id: string) => string;
};

function service(putDelayMs = 0) {
  const svc = Object.create(MediaService.prototype) as MediaService;
  const internals = svc as unknown as Internals;
  internals.uploadLocks = new Map();
  internals.logger = { log: jest.fn(), warn: jest.fn() };
  internals.storage = {
    putFileStream: jest.fn(() => new Promise<void>((resolve) => setTimeout(resolve, putDelayMs))),
  };
  internals.setAccess = jest.fn();
  internals.persistMetadata = jest.fn().mockResolvedValue(undefined);
  return { svc, internals };
}

const staged: string[] = [];
afterEach(async () => {
  for (const f of staged.splice(0)) await fs.remove(f);
});

async function openAndStage(svc: MediaService, internals: Internals, owner = OWNER) {
  const uploadId = await svc.initChunkedUpload(owner, undefined, undefined, 100 * 1024 * 1024);
  const file = internals.chunkTempPath(uploadId);
  staged.push(file);
  await svc.appendChunk(uploadId, SECOND_FILE, 100 * 1024 * 1024);
  return { uploadId, file };
}

describe('abortChunkedUpload', () => {
  it('removes the staged bytes, and a second call is a success (idempotent)', async () => {
    const { svc, internals } = service();
    const { uploadId, file } = await openAndStage(svc, internals);
    expect(await fs.pathExists(file)).toBe(true);

    await expect(svc.abortChunkedUpload(uploadId, OWNER)).resolves.toBe('removed');
    expect(await fs.pathExists(file)).toBe(false);
    await expect(svc.abortChunkedUpload(uploadId, OWNER)).resolves.toBe('absent');
  });

  it('refuses another member and leaves the session alone', async () => {
    const { svc, internals } = service();
    const { uploadId, file } = await openAndStage(svc, internals);

    await expect(svc.abortChunkedUpload(uploadId, 'someone-else')).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(await fs.pathExists(file)).toBe(true);
  });

  it('refuses a path that is not a UUID', async () => {
    const { svc } = service();
    await expect(svc.abortChunkedUpload('../../etc', OWNER)).rejects.toThrow('Invalid uploadId');
  });
});

describe('completeChunkedUpload is idempotent', () => {
  it('a second complete returns the SAME mediaId and stores nothing more', async () => {
    const { svc, internals } = service();
    const { uploadId } = await openAndStage(svc, internals);

    const first = await svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral');
    const again = await svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral');

    expect(again).toBe(first);
    expect(internals.storage.putFileStream).toHaveBeenCalledTimes(1);
  });

  it('a complete asked while the first is still assembling waits for it and gets the same id', async () => {
    const { svc, internals } = service(150);
    const { uploadId } = await openAndStage(svc, internals);

    const [a, b] = await Promise.all([
      svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral'),
      svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral'),
    ]);

    expect(b).toBe(a);
    expect(internals.storage.putFileStream).toHaveBeenCalledTimes(1);
  });

  it('another member cannot read the memo', async () => {
    const { svc, internals } = service();
    const { uploadId } = await openAndStage(svc, internals);
    await svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral');

    await expect(
      svc.completeChunkedUpload(uploadId, 1e8, 'someone-else', 'ephemeral')
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
