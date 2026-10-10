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
import { ForbiddenException, NotFoundException } from '@nestjs/common';
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
  // Completion records are sidecars next to the staging; none may outlive a test.
  for (const n of await fs.readdir('chunks_temp').catch(() => [] as string[])) {
    if (n.endsWith('.done')) await fs.remove(`chunks_temp/${n}`);
  }
});

async function openAndStage(svc: MediaService, internals: Internals, owner = OWNER) {
  const uploadId = await svc.initChunkedUpload(owner, undefined, undefined, 100 * 1024 * 1024);
  const file = internals.chunkTempPath(uploadId);
  staged.push(file);
  await svc.appendChunk(uploadId, SECOND_FILE, 100 * 1024 * 1024, owner);
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

describe('the completion record survives the process', () => {
  it('a NEW service instance (a restart) still answers the same mediaId and stores nothing', async () => {
    const first = service();
    const { uploadId } = await openAndStage(first.svc, first.internals);
    const mediaId = await first.svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral');
    staged.push(first.internals.chunkTempPath(uploadId) + '.done');

    const restarted = service();
    const again = await restarted.svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral');

    expect(again).toBe(mediaId);
    expect(restarted.internals.storage.putFileStream).not.toHaveBeenCalled();
  });

  it('refuses another member after the restart too', async () => {
    const first = service();
    const { uploadId } = await openAndStage(first.svc, first.internals);
    await first.svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral');
    staged.push(first.internals.chunkTempPath(uploadId) + '.done');

    const restarted = service();
    await expect(
      restarted.svc.completeChunkedUpload(uploadId, 1e8, 'someone-else', 'ephemeral')
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('the opener map does not leak', () => {
  const owners = (i: Internals) =>
    (i as unknown as { chunkOwners?: Map<string, string> }).chunkOwners;

  it('forgets a session once it completed', async () => {
    const { svc, internals } = service();
    const { uploadId } = await openAndStage(svc, internals);
    expect(owners(internals)?.has(uploadId)).toBe(true);
    await svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral');
    staged.push(internals.chunkTempPath(uploadId) + '.done');
    expect(owners(internals)?.has(uploadId)).toBe(false);
  });

  it('forgets a session whose append went over the cap', async () => {
    const { svc, internals } = service();
    const uploadId = await svc.initChunkedUpload(OWNER, undefined, undefined, 100);
    staged.push(internals.chunkTempPath(uploadId));
    await expect(svc.appendChunk(uploadId, Buffer.alloc(200), 100, OWNER)).rejects.toThrow(
      'Chunked upload exceeds'
    );
    expect(owners(internals)?.has(uploadId)).toBe(false);
  });

  it('KEEPS the opener after a failed complete: the staged bytes wait for the re-ask', async () => {
    const { svc, internals } = service();
    const { uploadId, file } = await openAndStage(svc, internals);
    internals.storage.putFileStream.mockRejectedValueOnce(new Error('storage down'));
    await expect(svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral')).rejects.toThrow(
      'storage down'
    );
    expect(owners(internals)?.get(uploadId)).toBe(OWNER);
    expect(await fs.pathExists(file)).toBe(true);
  });

  it('after a failed complete, ANOTHER member gets 403 and the opener can re-ask', async () => {
    const { svc, internals } = service();
    const { uploadId } = await openAndStage(svc, internals);
    internals.storage.putFileStream.mockRejectedValueOnce(new Error('storage down'));
    await expect(svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral')).rejects.toThrow(
      'storage down'
    );

    await expect(
      svc.completeChunkedUpload(uploadId, 1e8, 'someone-else', 'ephemeral')
    ).rejects.toBeInstanceOf(ForbiddenException);

    const mediaId = await svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral');
    staged.push(internals.chunkTempPath(uploadId) + '.done');
    expect(typeof mediaId).toBe('string');
    expect(owners(internals)?.has(uploadId)).toBe(false);
  });

  it('the sweeper forgets an opener whose staged file is gone', async () => {
    const { svc, internals } = service();
    const { uploadId, file } = await openAndStage(svc, internals);
    await fs.remove(file);
    await (svc as unknown as { purgeOrphanedChunks: () => Promise<void> }).purgeOrphanedChunks();
    expect(owners(internals)?.has(uploadId)).toBe(false);
  });
});

describe('the completion record is crash-safe and a lost session is a 404', () => {
  it('is written BEFORE the staging is removed, and whole (temp + rename)', async () => {
    const { svc, internals } = service();
    const { uploadId, file } = await openAndStage(svc, internals);
    const done = file + '.done';
    staged.push(done);
    let stagingPresentWhenRecordLanded: boolean | null = null;
    const priv = svc as unknown as {
      writeCompletedChunkUpload: (id: string, d: unknown) => Promise<void>;
    };
    const real = priv.writeCompletedChunkUpload.bind(svc);
    priv.writeCompletedChunkUpload = async (id, d) => {
      stagingPresentWhenRecordLanded = await fs.pathExists(file);
      return real(id, d);
    };
    await svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral');
    expect(stagingPresentWhenRecordLanded).toBe(true);
    expect(await fs.pathExists(done + '.tmp')).toBe(false);
  });

  it('a re-ask for a session that is gone throws NotFoundException (404), not a plain Error', async () => {
    const { svc } = service();
    await expect(
      svc.completeChunkedUpload('11111111-1111-4111-8111-111111111111', 1e8, OWNER, 'ephemeral')
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('an append to a session that is gone is a 404 as well', async () => {
    const { svc } = service();
    await expect(
      svc.appendChunk('22222222-2222-4222-8222-222222222222', SECOND_FILE, 1e8, OWNER)
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('the completion memo cannot be written (a full disk)', () => {
  it('KEEPS the staging and the opener, so a re-ask re-assembles under the opener check', async () => {
    const { svc, internals } = service();
    const { uploadId, file } = await openAndStage(svc, internals);
    const done = file + '.done';
    staged.push(done);
    // A DIRECTORY where the temp record goes makes the real write fail (EISDIR), like a full disk.
    await fs.ensureDir(done + '.tmp');
    const first = await svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral');
    await fs.remove(done + '.tmp');
    expect(typeof first).toBe('string');
    expect(await fs.pathExists(file)).toBe(true);
    expect(await fs.pathExists(done)).toBe(false);
    expect(internals.logger.warn).toHaveBeenCalledWith(expect.stringContaining('unrecorded'));

    // Another member is still refused; the opener's re-ask is answered, not a 404.
    await expect(
      svc.completeChunkedUpload(uploadId, 1e8, 'someone-else', 'ephemeral')
    ).rejects.toBeInstanceOf(ForbiddenException);
    const again = await svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral');
    expect(typeof again).toBe('string');
    expect(await fs.pathExists(file)).toBe(false);
  });
});

describe('append is owner-checked', () => {
  it('refuses another member and writes nothing', async () => {
    const { svc, internals } = service();
    const { uploadId, file } = await openAndStage(svc, internals);
    const before = (await fs.stat(file)).size;
    await expect(
      svc.appendChunk(uploadId, SECOND_FILE, 1e8, 'someone-else')
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((await fs.stat(file)).size).toBe(before);
    await expect(svc.appendChunk(uploadId, SECOND_FILE, 1e8, OWNER)).resolves.toBeUndefined();
    expect((await fs.stat(file)).size).toBe(before + SECOND_FILE.length);
  });
});

describe('an init that fails registers no opener', () => {
  it('a refused chat-reel init and a failed staging leave nothing for the sweeper to race', async () => {
    const { svc, internals } = service();
    const owners = () =>
      (internals as unknown as { chunkOwners?: Map<string, string> }).chunkOwners;
    await expect(svc.initChunkedUpload(OWNER, 'chat-reel', undefined, 1e8)).rejects.toThrow(
      'declares totalBytes'
    );
    expect(owners()?.size ?? 0).toBe(0);

    // A staging path under a FILE cannot be created (ENOTDIR): the real `ensureFile` fails.
    const blocker = 'chunks_temp/blocker-file';
    await fs.outputFile(blocker, 'x');
    staged.push(blocker);
    (internals as unknown as { chunkTempPath: (id: string) => string }).chunkTempPath = (id) =>
      `${blocker}/${id}`;
    await expect(svc.initChunkedUpload(OWNER, undefined, undefined, 1e8)).rejects.toThrow(
      'ENOTDIR'
    );
    expect(owners()?.size ?? 0).toBe(0);
  });
});

describe('abort and complete racing, in either order', () => {
  it('a DELETE during an in-flight complete waits for it: the object survives and the re-ask answers', async () => {
    const { svc, internals } = service(150);
    const { uploadId } = await openAndStage(svc, internals);
    staged.push(internals.chunkTempPath(uploadId) + '.done');

    const completing = svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral');
    // Let the complete take the lock and reach the slow putFileStream.
    await new Promise((r) => setTimeout(r, 30));
    expect(internals.storage.putFileStream).toHaveBeenCalledTimes(1);
    const aborting = svc.abortChunkedUpload(uploadId, OWNER);

    const [mediaId, outcome] = await Promise.all([completing, aborting]);
    expect(outcome).toBe('absent');
    await expect(svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral')).resolves.toBe(
      mediaId
    );
    expect(internals.storage.putFileStream).toHaveBeenCalledTimes(1);
  });

  it('an abort after a finished complete is a success and leaves the memo answering', async () => {
    const { svc, internals } = service();
    const { uploadId } = await openAndStage(svc, internals);
    const mediaId = await svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral');
    staged.push(internals.chunkTempPath(uploadId) + '.done');

    await expect(svc.abortChunkedUpload(uploadId, OWNER)).resolves.toBe('absent');
    await expect(svc.completeChunkedUpload(uploadId, 1e8, OWNER, 'ephemeral')).resolves.toBe(
      mediaId
    );
  });
});

describe('the sweeper takes a stale completion record', () => {
  it('removes an aged .done and .done.tmp, and keeps a fresh one', async () => {
    const { svc, internals } = service();
    const old = '33333333-3333-4333-8333-333333333333';
    const fresh = '44444444-4444-4444-8444-444444444444';
    const files = [
      internals.chunkTempPath(old) + '.done',
      internals.chunkTempPath(old) + '.done.tmp',
      internals.chunkTempPath(fresh) + '.done',
    ];
    for (const f of files) {
      await fs.outputFile(f, '{}');
      staged.push(f);
    }
    const aged = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(files[0], aged, aged);
    await fs.utimes(files[1], aged, aged);

    await (svc as unknown as { purgeOrphanedChunks: () => Promise<void> }).purgeOrphanedChunks();

    expect(await fs.pathExists(files[0])).toBe(false);
    expect(await fs.pathExists(files[1])).toBe(false);
    expect(await fs.pathExists(files[2])).toBe(true);
  });
});
