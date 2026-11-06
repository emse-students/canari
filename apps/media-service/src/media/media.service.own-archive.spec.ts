/// <reference types="jest" />

/**
 * `removeOwnArchive`: the publish queue's Delete takes back the post media it uploaded for a post
 * that will never exist. A user route, so it is pinned to exactly one thing - the caller's own
 * `archive` object - and is idempotent on an object already gone.
 */
import { BadRequestException } from '@nestjs/common';
import { MediaService } from './media.service';

const ID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';

function build(entry: Record<string, unknown> | undefined) {
  const svc = Object.create(MediaService.prototype) as MediaService;
  const remove = jest.fn(() => Promise.resolve());
  Object.assign(svc, {
    meta: { items: entry ? { [ID]: entry } : {} },
    logger: { log: jest.fn(), warn: jest.fn() },
    remove,
  });
  return { svc, remove };
}

describe('MediaService.removeOwnArchive', () => {
  it("deletes the caller's own post media", async () => {
    const { svc, remove } = build({ ownerId: 'alice', retentionClass: 'archive', createdAt: 0 });
    await expect(svc.removeOwnArchive(ID, 'alice')).resolves.toBe('deleted');
    expect(remove).toHaveBeenCalledWith(ID);
  });

  it.each([
    ['another member', { ownerId: 'bob', retentionClass: 'archive' }],
    ['no recorded uploader', { retentionClass: 'archive' }],
    ['a reel', { ownerId: 'alice', retentionClass: 'reel' }],
    ['a chat file', { ownerId: 'alice', retentionClass: 'chat-reel' }],
    ['a form file', { ownerId: 'alice', retentionClass: 'form-file' }],
  ])('refuses %s, and deletes nothing', async (_what, entry) => {
    const { svc, remove } = build({ createdAt: 0, ...entry });
    await expect(svc.removeOwnArchive(ID, 'alice')).resolves.toBe('refused');
    expect(remove).not.toHaveBeenCalled();
  });

  it('answers an unknown or purged object as gone, so a repeat is harmless', async () => {
    await expect(build(undefined).svc.removeOwnArchive(ID, 'alice')).resolves.toBe('absent');
    const purged = build({ ownerId: 'alice', retentionClass: 'archive', purgedAt: 1 });
    await expect(purged.svc.removeOwnArchive(ID, 'alice')).resolves.toBe('absent');
    expect(purged.remove).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a UUID', async () => {
    await expect(build(undefined).svc.removeOwnArchive('../x', 'alice')).rejects.toThrow(
      BadRequestException
    );
  });
});
