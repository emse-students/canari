/**
 * EVERY TEST FILE RUNS IN A WORKING DIRECTORY OF ITS OWN, made here and removed after it.
 *
 * WHY. media-service resolves its disk directories from `process.cwd()` (`chunks_temp`, `media_meta`,
 * `upload_sessions`), and so do the specs that touch the real filesystem. Run from the package, the
 * suite wrote into `apps/media-service/chunks_temp` - a directory that was COMMITTED, so every run
 * deleted tracked files - and two workers shared it, which is how one spec's orphan purge once wiped
 * another's staged upload (CHANGELOG, `media.service.chat-holds.spec.ts`). A fresh temporary
 * directory per file makes the suite leave the checkout untouched and isolates the files from each
 * other, whatever a spec writes and whether it remembers to clean up.
 *
 * Loaded through `setupFilesAfterEnv` (package.json and jest-boot.json), so it runs before the test
 * file is required - before `media.service.ts` computes its directories at import.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const previous = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-service-test-'));
process.chdir(dir);

afterAll(() => {
  process.chdir(previous);
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * THE RETENTION DURATIONS ARE ANSWERED WITHOUT A NETWORK. Every upload of an `ephemeral` or
 * `chat-reel` file, and every chat hold, reads the durations in force from social-service's relay
 * (`MediaService.readRetention`, docs/wiki/retention-settings.md); a spec has no social-service, so the
 * read answers the values the columns are created with (core migration 025). A spec about the read
 * itself replaces this answer with its own `jest.spyOn`.
 */
beforeEach(() => {
  const { MediaService } = require('./src/media/media.service');
  jest
    .spyOn(MediaService.prototype, 'readRetention')
    .mockResolvedValue({ chatReelDays: 30, idleMediaDays: 90 });
});
