/**
 * The metadata index is written ATOMICALLY (temp file, then rename) and ONE WRITE AT A TIME.
 *
 * Pinned because the opposite is what ran until 2026-10-11: `persistMetadata` was a bare
 * `writeJson` onto `media_metadata.json`, called un-awaited from many paths at once. Two overlapping
 * writes interleave on one file, and a crash mid-write leaves a truncated index that the next boot
 * cannot parse - every entry lost, so the sweep and an account deletion can no longer see them.
 */
import * as fs from 'fs-extra';
import { MediaService } from './media.service';

jest.mock('fs-extra', () => ({
  writeJson: jest.fn(),
  rename: jest.fn(),
}));

const mocked = fs as unknown as { writeJson: jest.Mock; rename: jest.Mock };

type ServiceInternals = {
  meta: { items: Record<string, { createdAt: number; lastAccessAt: number }> };
  logger: Record<'log' | 'debug' | 'warn' | 'error', (msg: string) => void>;
  persistMetadata: () => Promise<void>;
};

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function service() {
  const svc = Object.create(MediaService.prototype) as MediaService;
  const internals = svc as unknown as ServiceInternals;
  internals.meta = { items: { [UUID_A]: { createdAt: 1, lastAccessAt: 1 } } };
  internals.logger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
  return internals;
}

/** Yields until every queued microtask and one macrotask have run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  mocked.writeJson.mockReset();
  mocked.rename.mockReset();
});

describe('persistMetadata: atomic', () => {
  it('writes a temp file, then renames it over the index', async () => {
    const calls: string[] = [];
    mocked.writeJson.mockImplementation((file: string) => {
      calls.push(`write ${file}`);
      return Promise.resolve();
    });
    mocked.rename.mockImplementation((from: string, to: string) => {
      calls.push(`rename ${from} -> ${to}`);
      return Promise.resolve();
    });

    await service().persistMetadata();

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^write .*media_metadata\.json\.tmp$/);
    expect(calls[1]).toMatch(/^rename .*media_metadata\.json\.tmp -> .*media_metadata\.json$/);
  });

  it('never renames a temp file whose write failed, and hands the failure to its caller', async () => {
    mocked.writeJson.mockRejectedValue(new Error('ENOSPC'));

    await expect(service().persistMetadata()).rejects.toThrow('ENOSPC');
    expect(mocked.rename).not.toHaveBeenCalled();
  });
});

describe('persistMetadata: serialised', () => {
  it('never starts a write before the previous one has renamed', async () => {
    const releases: Array<() => void> = [];
    mocked.writeJson.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        })
    );
    mocked.rename.mockResolvedValue(undefined);
    const internals = service();

    const first = internals.persistMetadata();
    const second = internals.persistMetadata();
    await settle();

    // The second write is queued, not running alongside the first.
    expect(mocked.writeJson).toHaveBeenCalledTimes(1);

    releases[0]();
    await first;
    await settle();
    expect(mocked.rename).toHaveBeenCalledTimes(1);
    expect(mocked.writeJson).toHaveBeenCalledTimes(2);

    releases[1]();
    await second;
    expect(mocked.rename).toHaveBeenCalledTimes(2);
  });

  it('carries the index as it is when its turn comes, so the last write holds the latest state', async () => {
    const written: number[] = [];
    let releaseFirst: () => void = () => {};
    mocked.writeJson
      .mockImplementationOnce((_file: string, data: { items: Record<string, unknown> }) => {
        written.push(Object.keys(data.items).length);
        return new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      })
      .mockImplementation((_file: string, data: { items: Record<string, unknown> }) => {
        written.push(Object.keys(data.items).length);
        return Promise.resolve();
      });
    mocked.rename.mockResolvedValue(undefined);
    const internals = service();

    const first = internals.persistMetadata();
    const second = internals.persistMetadata();
    await settle();
    // An entry added while the first write is in flight.
    internals.meta.items['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] = {
      createdAt: 2,
      lastAccessAt: 2,
    };
    releaseFirst();
    await Promise.all([first, second]);

    expect(written).toEqual([1, 2]);
  });

  it('runs the next write after a failed one - a failure does not poison the queue', async () => {
    mocked.writeJson.mockRejectedValueOnce(new Error('EIO')).mockResolvedValue(undefined);
    mocked.rename.mockResolvedValue(undefined);
    const internals = service();

    const first = internals.persistMetadata();
    const second = internals.persistMetadata();

    await expect(first).rejects.toThrow('EIO');
    await expect(second).resolves.toBeUndefined();
    expect(mocked.rename).toHaveBeenCalledTimes(1);
  });
});
