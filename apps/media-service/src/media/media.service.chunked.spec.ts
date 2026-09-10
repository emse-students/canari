/// <reference types="jest" />

/**
 * `MediaService.appendChunk` - the one endpoint that writes attacker-supplied bytes to disk at an
 * attacker-supplied name, and the two things that make that safe.
 *
 * WHY THESE EXIST. The static analyser reports this method twice, and it is right about what it
 * can see: *"write to file system depends on untrusted data"* and *"the file may have changed
 * since it was checked"*. Neither is a defect here, but *"it is fine"* is not an argument - a
 * suppression has to assert its own premise, and until 2026-09-10 nothing in this repository
 * asserted either half. The chunked upload path had no test at all.
 *
 * THE TWO PREMISES, and each has a case below:
 *
 *   1. THE PATH IS NOT ATTACKER-CHOSEN. `uploadId` is checked against `UUID_REGEX` and then the
 *      RESOLVED path is checked to still be under the chunk directory - belt and braces, because
 *      a regex is a claim about a string and `path.resolve` is what actually decides where the
 *      write lands.
 *   2. THE CONTENT IS CAPPED. The bytes themselves are the payload this endpoint exists to store,
 *      so the question is not whether they are trusted but whether they are bounded.
 *
 * AND THE THIRD CASE IS THE ONE THAT CHANGED. `pathExists` followed by `stat` was a check
 * followed by an act on the strength of it; `stat` alone answers both questions, and reports
 * absence by throwing. The message a caller sees must not change with it.
 */
import { PayloadTooLargeException } from '@nestjs/common';
import * as fs from 'fs-extra';
import { MediaService } from './media.service';

// THE MODULE IS MOCKED RATHER THAN SPIED ON. `media.service.ts` does `import * as fs from
// 'fs-extra'`, and a namespace import's bindings are not writable - a spy on it fails SILENTLY,
// so the first version of this file ran the real `stat` against a path that does not exist and
// read the resulting refusal as the behaviour under test. Two cases passed for the wrong reason
// and two failed for the right one, which is how it was noticed.
jest.mock('fs-extra', () => ({
  promises: { open: jest.fn() },
  remove: jest.fn(),
  ensureFile: jest.fn(),
}));

const mocked = fs as unknown as {
  promises: { open: jest.Mock };
  remove: jest.Mock;
};

/** A file handle that reports `size` and records what was written through it. */
function handle(size: number) {
  return {
    stat: jest.fn().mockResolvedValue({ size }),
    write: jest.fn().mockResolvedValue({ bytesWritten: 0 }),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

const UUID = '11111111-1111-4111-8111-111111111111';

type ServiceInternals = {
  uploadLocks: Map<string, Promise<void>>;
  chunkTempPath: (uploadId: string) => string;
};

/** A service with only what `appendChunk` touches: the lock map and the path helper's own guards. */
function service(): MediaService {
  const svc = Object.create(MediaService.prototype) as MediaService;
  (svc as unknown as ServiceInternals).uploadLocks = new Map();
  return svc;
}

describe('MediaService.appendChunk - the premises that make an untrusted write safe', () => {
  beforeEach(() => {
    mocked.promises.open.mockReset();
    mocked.remove.mockReset().mockResolvedValue(undefined);
  });

  describe('the path is not attacker-chosen', () => {
    it.each([
      ['a traversal', '../../etc/passwd'],
      ['a traversal that ends in a UUID', `../${UUID}`],
      ['an absolute path', '/etc/passwd'],
      ['an empty id', ''],
      ['a plausible but non-UUID id', 'upload-12345'],
    ])('refuses %s before touching the filesystem', async (_why, uploadId) => {
      // THE MESSAGE, NOT THE CLASS: `Invalid upload path` is a different guard from
      // `Invalid uploadId`, and a test that accepts either cannot say which one is holding.
      //
      // THE UUID CHECK IS WRITTEN TWICE - once at the top of `appendChunk`, once inside
      // `chunkTempPath` - and this asserts the PROPERTY rather than a line, so it survives
      // either copy being removed and fails when both are. Measured: removing one leaves all
      // eight cases green, removing both fails these five. That is defence in depth doing its
      // job, and it is worth knowing which is which before anybody deletes "the redundant one".
      await expect(service().appendChunk(uploadId, Buffer.from('x'), 1_000)).rejects.toThrow(
        'Invalid uploadId'
      );

      // NOT TOUCHING THE FILESYSTEM IS PART OF THE ASSERTION. A refusal that happens after the
      // attacker's path has already been opened is a refusal that leaked the path.
      expect(mocked.promises.open).not.toHaveBeenCalled();
    });
  });

  describe('the content is capped', () => {
    it('refuses a chunk that would take the session over the cap, and removes the session', async () => {
      const h = handle(900);
      mocked.promises.open.mockResolvedValue(h);

      await expect(service().appendChunk(UUID, Buffer.alloc(200), 1_000)).rejects.toThrow(
        PayloadTooLargeException
      );

      // The partial upload is deleted rather than left occupying the volume until the sweeper
      // runs - and the handle is closed FIRST, because a Windows runner refuses to unlink a file
      // that is still open.
      expect(h.write).not.toHaveBeenCalled();
      expect(h.close).toHaveBeenCalledTimes(1);
      expect(mocked.remove).toHaveBeenCalledTimes(1);
    });

    it('accepts a chunk that fits exactly', async () => {
      const h = handle(900);
      mocked.promises.open.mockResolvedValue(h);

      await expect(service().appendChunk(UUID, Buffer.alloc(100), 1_000)).resolves.toBeUndefined();
      // WRITTEN AT THE OFFSET THE SIZE WAS READ AT, on the same handle. That is what makes the
      // measurement and the write one decision instead of two.
      expect(h.write).toHaveBeenCalledWith(expect.any(Buffer), 0, 100, 900);
      expect(h.close).toHaveBeenCalledTimes(1);
      expect(mocked.remove).not.toHaveBeenCalled();
    });
  });

  describe('an absent session', () => {
    it('is reported as an expired session rather than as a filesystem error', async () => {
      // OPENING IS THE ONLY EXISTENCE CHECK, and `r+` is what makes it one: `a` would CREATE the
      // file and turn an expired upload into a new one. What a caller sees must not change.
      mocked.promises.open.mockRejectedValue(
        Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      );

      await expect(service().appendChunk(UUID, Buffer.from('x'), 1_000)).rejects.toThrow(
        'Upload session not found or expired'
      );
      expect(mocked.promises.open).toHaveBeenCalledWith(expect.any(String), 'r+');
    });
  });
});
