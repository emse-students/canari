/// <reference types="jest" />

/**
 * StorageService.putFileStream: the 5 MiB part size is scoped to it, and a failed streamed upload is
 * cleaned up. The S3 client is a stub; whether Garage accepts the multipart path is NOT proven here.
 */
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

const created: Array<Record<string, unknown>> = [];
const clients: Array<{
  putObject: jest.Mock;
  removeIncompleteUpload: jest.Mock;
}> = [];

jest.mock('minio', () => ({
  Client: jest.fn().mockImplementation((options: Record<string, unknown>) => {
    created.push(options);
    const client = {
      putObject: jest.fn(async (_b: string, _k: string, s: AsyncIterable<unknown> | Buffer) => {
        if (Symbol.asyncIterator in (s as object))
          for await (const _chunk of s as AsyncIterable<unknown>);
        return {};
      }),
      removeIncompleteUpload: jest.fn().mockResolvedValue(undefined),
    };
    clients.push(client);
    return client;
  }),
}));

import { STORE_PART_BYTES, StorageService } from './storage.service';

process.env.GARAGE_ACCESS_KEY_ID = 'k';
process.env.GARAGE_SECRET_ACCESS_KEY = 's';

let dir: string;
beforeEach(() => {
  created.length = 0;
  clients.length = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-spec-'));
});
afterEach(() => fs.removeSync(dir));

const quiet = (svc: StorageService) => {
  (svc as unknown as { logger: unknown }).logger = { error: () => {}, log: () => {} };
  return svc;
};

describe('the two clients', () => {
  it('keeps the default part size for the general client and 5 MiB for the streaming one only', () => {
    new StorageService();
    expect(created).toHaveLength(2);
    expect(created[0].partSize).toBeUndefined();
    expect(created[1].partSize).toBe(STORE_PART_BYTES);
  });

  it('put() goes through the general client', async () => {
    const svc = new StorageService();
    await svc.put('a', Buffer.alloc(10), 10);
    expect(clients[0].putObject).toHaveBeenCalledTimes(1);
    expect(clients[1].putObject).not.toHaveBeenCalled();
  });
});

describe('putFileStream', () => {
  it('streams the file through the 5 MiB client with its exact size', async () => {
    const file = path.join(dir, 'f.bin');
    await fs.writeFile(file, Buffer.alloc(100));
    await new StorageService().putFileStream('obj', file, 100);
    expect(clients[1].putObject).toHaveBeenCalledWith(
      'canari-media',
      'obj',
      expect.anything(),
      100,
      expect.anything()
    );
    expect(clients[1].removeIncompleteUpload).not.toHaveBeenCalled();
  });

  it('on failure destroys the read stream, removes the incomplete upload and rethrows', async () => {
    const file = path.join(dir, 'f.bin');
    await fs.writeFile(file, Buffer.alloc(100));
    const svc = quiet(new StorageService());
    let source: { destroyed: boolean; closed: boolean } | undefined;
    clients[1].putObject.mockImplementationOnce(
      async (_b: string, _k: string, s: { destroyed: boolean; closed: boolean }) => {
        source = s;
        throw new Error('part 3 refused');
      }
    );
    await expect(svc.putFileStream('obj', file, 100)).rejects.toThrow('part 3 refused');
    expect(source?.destroyed).toBe(true);
    while (!source?.closed) await new Promise((r) => setImmediate(r));
    expect(clients[1].removeIncompleteUpload).toHaveBeenCalledWith('canari-media', 'obj');
  });

  it('still rethrows the ORIGINAL error when the cleanup itself fails', async () => {
    const file = path.join(dir, 'f.bin');
    await fs.writeFile(file, Buffer.alloc(10));
    const svc = quiet(new StorageService());
    let source: { closed: boolean } | undefined;
    clients[1].putObject.mockImplementationOnce(
      async (_b: string, _k: string, s: { closed: boolean }) => {
        source = s;
        throw new Error('boom');
      }
    );
    clients[1].removeIncompleteUpload.mockRejectedValueOnce(new Error('abort failed'));
    await expect(svc.putFileStream('obj', file, 10)).rejects.toThrow('boom');
    while (!source?.closed) await new Promise((r) => setImmediate(r));
  });
});
