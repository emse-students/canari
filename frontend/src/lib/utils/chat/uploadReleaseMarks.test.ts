import { describe, expect, it, vi } from 'vitest';
import {
  UPLOAD_RELEASE_MARKS_KEY,
  dropUploadReleaseMarksOf,
  markUploadForRelease,
  releaseUploadDurably,
  sweepUploadReleaseMarks,
  uploadReleaseMarksOf,
  type MarkStore,
  type ReleaseAnswer,
} from './uploadReleaseMarks';
import { releaseUploadSession, uploadResumable } from '$lib/utils/resumableUpload';
import { FakeSessionServer } from '../../../test/fakeUploadSessionServer';

/** A Map-backed `localStorage`: the marks' one store, outliving any outbox. */
function memoryStore(): MarkStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const quiet = () => undefined;

/** Opens a real session on the fake server and leaves it open (the second part is cut). */
async function openSession(server: FakeSessionServer): Promise<string> {
  let id: string | undefined;
  let puts = 0;
  server.fault = (method) => (method === 'PUT' && ++puts === 2 ? 'drop' : undefined);
  await uploadResumable({
    plaintext: new Uint8Array(40_000).fill(7),
    retentionClass: 'chat-reel',
    partBytes: 10 * 1024,
    log: quiet,
    persist: async (s) => {
      id = s.uploadId ?? id;
    },
    port: server.port(),
  }).catch(() => undefined);
  server.fault = () => undefined;
  return id!;
}

describe('the durable release of an upload session', () => {
  it('a cancel made OFFLINE keeps the mark; the next start, online, releases the session and drops it', async () => {
    const server = new FakeSessionServer();
    const store = memoryStore();
    const id = await openSession(server);
    const release = (uploadId: string, why: string) =>
      releaseUploadSession(server.port(), uploadId, why, quiet);

    // Offline: the DELETE never reaches the server.
    server.fault = (method) => (method === 'DELETE' ? 'drop' : undefined);
    expect(await releaseUploadDurably('alice', id, 'withdrawn', release, quiet, store)).toBe(
      'unanswered'
    );
    expect(uploadReleaseMarksOf('alice', quiet, store)).toEqual([id]);
    expect(server.sessions.get(id)!.closed).toBeUndefined();

    // "Relaunch": nothing in memory survives, only the store. The link is back.
    server.fault = () => undefined;
    expect(await sweepUploadReleaseMarks('alice', release, quiet, store)).toEqual({
      released: 1,
      kept: 0,
    });
    expect(server.sessions.get(id)!.closed).toBe(true);
    expect(store.map.has(UPLOAD_RELEASE_MARKS_KEY)).toBe(false);
  });

  it('an answered release leaves no mark behind', async () => {
    const store = memoryStore();
    const release = vi.fn(async (): Promise<ReleaseAnswer> => {
      // The mark is durable BEFORE the DELETE goes: a kill during it still owes the release.
      expect(uploadReleaseMarksOf('alice', quiet, store)).toEqual(['s1']);
      return 'answered';
    });
    await releaseUploadDurably('alice', 's1', 'withdrawn', release, quiet, store);
    expect(release).toHaveBeenCalledOnce();
    expect(uploadReleaseMarksOf('alice', quiet, store)).toEqual([]);
  });

  it('a sweep keeps what is still unanswered, and is idempotent', async () => {
    const store = memoryStore();
    markUploadForRelease('alice', 'a', quiet, store);
    markUploadForRelease('alice', 'b', quiet, store);
    markUploadForRelease('alice', 'b', quiet, store);
    const release = async (id: string): Promise<ReleaseAnswer> =>
      id === 'a' ? 'answered' : 'unanswered';
    expect(await sweepUploadReleaseMarks('alice', release, quiet, store)).toEqual({
      released: 1,
      kept: 1,
    });
    expect(uploadReleaseMarksOf('alice', quiet, store)).toEqual(['b']);
    expect(await sweepUploadReleaseMarks('alice', async () => 'answered', quiet, store)).toEqual({
      released: 1,
      kept: 0,
    });
    expect(await sweepUploadReleaseMarks('alice', release, quiet, store)).toEqual({
      released: 0,
      kept: 0,
    });
  });

  it('a session already gone on the server (404) is an answer: the mark goes', async () => {
    const server = new FakeSessionServer();
    const store = memoryStore();
    const id = await openSession(server);
    const release = (uploadId: string, why: string) =>
      releaseUploadSession(server.port(), uploadId, why, quiet);
    expect(await release(id, 'first')).toBe('answered');
    markUploadForRelease('alice', id, quiet, store);
    expect(await sweepUploadReleaseMarks('alice', release, quiet, store)).toEqual({
      released: 1,
      kept: 0,
    });
  });

  it("never releases another owner's marks, and a releaser that throws keeps the mark", async () => {
    const store = memoryStore();
    markUploadForRelease('bob', 'x', quiet, store);
    const lines: string[] = [];
    expect(
      await releaseUploadDurably(
        'alice',
        'y',
        'withdrawn',
        async () => {
          throw new Error('boom');
        },
        (l) => lines.push(l),
        store
      )
    ).toBe('unanswered');
    expect(lines.some((l) => l.includes('threw'))).toBe(true);
    const seen: string[] = [];
    await sweepUploadReleaseMarks(
      'alice',
      async (id) => {
        seen.push(id);
        return 'answered';
      },
      quiet,
      store
    );
    expect(seen).toEqual(['y']);
    expect(uploadReleaseMarksOf('bob', quiet, store)).toEqual(['x']);
  });

  it("an account deletion drops that account's marks and no other", () => {
    const store = memoryStore();
    markUploadForRelease('alice', 'a', quiet, store);
    markUploadForRelease('bob', 'b', quiet, store);
    dropUploadReleaseMarksOf('alice', quiet, store);
    expect(uploadReleaseMarksOf('alice', quiet, store)).toEqual([]);
    expect(uploadReleaseMarksOf('bob', quiet, store)).toEqual(['b']);
  });

  it('a damaged value is said at ERROR and dropped, never thrown', () => {
    const store = memoryStore();
    store.setItem(UPLOAD_RELEASE_MARKS_KEY, '{not json');
    const lines: string[] = [];
    expect(uploadReleaseMarksOf('alice', (l) => lines.push(l), store)).toEqual([]);
    expect(lines.some((l) => l.includes('ERROR'))).toBe(true);
    expect(store.map.has(UPLOAD_RELEASE_MARKS_KEY)).toBe(false);
  });
});
