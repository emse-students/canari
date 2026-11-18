import { describe, expect, it, vi } from 'vitest';
import {
  RESUMABLE_MAX_ROUNDS,
  RESUMABLE_PARTS_IN_FLIGHT,
  releaseUploadSession,
  sealBlobRange,
  uploadResumable,
  type ResumableUploadState,
} from './resumableUpload';
import {
  SEGMENTED_MEDIA_ENCODING,
  decryptSegmentedMediaBuffer,
  segmentedCiphertextLength,
} from '$lib/mediaSegmented';
import { hexDecode, hexEncode } from '$lib/mediaCrypto';
import { MediaUploadError, uploadRefusalCause } from '$lib/utils/mediaErrors';
import { UploadAbortedError, UploadNetworkError } from '$lib/utils/uploadXhr';
import { isTransportFailure } from '$lib/utils/transportFailure';
import { FakeSessionServer } from '../../test/fakeUploadSessionServer';

/** The part size these tests ask for: small, so a 40 kB file has 4 parts and the suite stays fast. */
const PART = 10 * 1024;

/** `uploadResumable` with this suite's part size and a silent log. */
function up(
  o: Omit<Parameters<typeof uploadResumable>[0], 'partBytes' | 'log'> & {
    log?: (line: string) => void;
  }
) {
  return uploadResumable({ partBytes: PART, log: () => undefined, ...o });
}

/** Byte equality without a deep-equal walk (which costs seconds on a megabyte). */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A deterministic plaintext of a counter pattern; 40 kB is 4 parts of {@link PART}. */
function plaintextOf(bytes = 40_000): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

/** A recorder for what `persist` was handed, the stand-in for the encrypted outbox row. */
function rowStore() {
  const writes: ResumableUploadState[] = [];
  return {
    writes,
    persist: async (s: ResumableUploadState) => {
      writes.push({ ...s });
    },
    get last(): ResumableUploadState | undefined {
      return writes.at(-1);
    },
  };
}

const quiet = () => undefined;

async function decrypts(
  server: FakeSessionServer,
  mediaId: string,
  keyHex: string,
  ivHex: string,
  plaintext: Uint8Array
): Promise<void> {
  const blob = server.stored.get(mediaId)!;
  expect(blob.length).toBe(segmentedCiphertextLength(plaintext.length));
  const opened = new Uint8Array(
    await decryptSegmentedMediaBuffer(blob.slice().buffer, keyHex, ivHex)
  );
  expect(sameBytes(opened, plaintext)).toBe(true);
}

describe('sealBlobRange (one part sealed at a time)', () => {
  it('the parts, concatenated, are the whole segmented blob - and the same bytes on every call', async () => {
    const plaintext = plaintextOf(2 * 1024 * 1024 + 123);
    const keyHex = hexEncode(crypto.getRandomValues(new Uint8Array(32)));
    const ivHex = hexEncode(crypto.getRandomValues(new Uint8Array(12)));
    const key = await crypto.subtle.importKey('raw', hexDecode(keyHex), 'AES-GCM', false, [
      'encrypt',
    ]);
    const iv = hexDecode(ivHex);
    const total = segmentedCiphertextLength(plaintext.length);
    const partBytes = 700_000; // straddles segment boundaries on purpose
    const blob = new Uint8Array(total);
    for (let start = 0; start < total; start += partBytes) {
      const end = Math.min(total, start + partBytes);
      const part = await sealBlobRange(plaintext, key, iv, start, end);
      expect(sameBytes(part, await sealBlobRange(plaintext, key, iv, start, end))).toBe(true);
      blob.set(part, start);
    }
    const opened = new Uint8Array(await decryptSegmentedMediaBuffer(blob.buffer, keyHex, ivHex));
    expect(sameBytes(opened, plaintext)).toBe(true);
  });
});

describe('uploadResumable', () => {
  it('uploads a reel in parts of at most 1 MiB, recording the session BEFORE the first part', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    const plaintext = plaintextOf();
    const order: string[] = [];
    const port = server.port();
    const done = await up({
      plaintext,
      retentionClass: 'chat-reel',
      persist: async (s) => {
        order.push(`persist:${server.partsReceived()}`);
        await row.persist(s);
      },
      port,
      log: quiet,
    });
    expect(order).toEqual(['persist:0']);
    expect(done.encoding).toBe(SEGMENTED_MEDIA_ENCODING);
    expect(server.partsReceived()).toBe(4);
    expect(server.sessions.get(row.last!.uploadId!)!.retentionClass).toBe('chat-reel');
    expect(server.reservations).toBe(1);
    await decrypts(server, done.mediaId, done.keyHex, done.ivHex, plaintext);
  });

  it('reports the progress of the WHOLE blob across parts', async () => {
    const server = new FakeSessionServer();
    const plaintext = plaintextOf();
    const seen: number[] = [];
    await up({
      plaintext,
      retentionClass: 'chat-reel',
      persist: rowStore().persist,
      port: server.port(),
      transport: { onProgress: (p) => seen.push(p.loaded) },
      log: quiet,
    });
    const total = segmentedCiphertextLength(plaintext.length);
    expect(seen.at(-1)).toBe(total);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  for (const cutAt of [1, 2, 3, 4]) {
    it(`a link cut on part ${cutAt} of 4: the next attempt sends ONLY the missing parts, and the blob is whole`, async () => {
      const server = new FakeSessionServer();
      const row = rowStore();
      const plaintext = plaintextOf();
      let puts = 0;
      server.fault = (method) => (method === 'PUT' && ++puts === cutAt ? 'drop' : undefined);
      const first = up({
        plaintext,
        retentionClass: 'chat-reel',
        persist: row.persist,
        port: server.port(),
        log: quiet,
      });
      const err = await first.catch((e: unknown) => e);
      expect(isTransportFailure(err)).toBe(true);
      const id = row.last!.uploadId!;
      // The session was kept for the resume - never released on a transport failure.
      expect(server.sessions.get(id)!.closed).toBeUndefined();
      // A round opens its second lane once a part has committed (`RESUMABLE_PARTS_IN_FLIGHT`): a cut
      // on the first part leaves nothing; after that, the part in flight beside the cut finishes
      // and is kept, so the server holds every part but the cut one (the last has none beside it).
      expect(server.partsReceived(id)).toBe(cutAt === 1 ? 0 : Math.min(cutAt, 3));

      // A "relaunch": a new call, with only what the row recorded.
      server.fault = () => undefined;
      const done = await up({
        plaintext,
        retentionClass: 'chat-reel',
        state: row.last,
        persist: row.persist,
        port: server.port(),
        log: quiet,
      });
      expect(server.partsReceived(id)).toBe(4);
      expect(server.reservations).toBe(1);
      await decrypts(server, done.mediaId, done.keyHex, done.ivHex, plaintext);
    });
  }

  it('a part whose ANSWER was lost is re-sent once (the same bytes), never twice', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    const plaintext = plaintextOf();
    server.fault = (method, path) =>
      method === 'PUT' && path.endsWith('/parts/1') ? 'lose-answer' : undefined;
    await up({
      plaintext,
      retentionClass: 'chat-reel',
      persist: row.persist,
      port: server.port(),
      log: quiet,
    }).catch(() => undefined);
    const id = row.last!.uploadId!;
    // The server holds parts 0 and 1 though the client saw no answer for 1, and part 2, which was in
    // flight beside it. Part 3 MAY be held too: the second lane takes it when part 2's answer lands
    // before part 1's lost one ends the round, and the two answers race by design (a failure of one
    // lane never aborts the other's part). The proof that nothing is sent twice is the PUT count below.
    const firstRound = [...server.sessions.get(id)!.received].sort();
    expect(firstRound.slice(0, 3)).toEqual([0, 1, 2]);
    expect(firstRound.length).toBeLessThanOrEqual(4);
    server.fault = () => undefined;
    const done = await up({
      plaintext,
      retentionClass: 'chat-reel',
      state: row.last,
      persist: row.persist,
      port: server.port(),
      log: quiet,
    });
    // Four PUTs over both rounds, whichever round carried part 3: the server's fact said 0, 1 and 2
    // (and 3, when the race let it through) were there, so none was re-sent.
    expect(server.partsReceived(id)).toBe(4);
    await decrypts(server, done.mediaId, done.keyHex, done.ivHex, plaintext);
  });

  it('a kill after `complete` landed but before its answer: the resume uploads NOTHING and gets the same mediaId', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    const plaintext = plaintextOf();
    server.fault = (method, path) =>
      method === 'POST' && path.endsWith('/complete') ? 'lose-answer' : undefined;
    await up({
      plaintext,
      retentionClass: 'chat-reel',
      persist: row.persist,
      port: server.port(),
      log: quiet,
    }).catch(() => undefined);
    const id = row.last!.uploadId!;
    const stored = server.sessions.get(id)!.completed!;
    expect(stored).toBeTruthy();
    const before = server.seen.length;
    server.fault = () => undefined;
    const done = await up({
      plaintext,
      retentionClass: 'chat-reel',
      state: row.last,
      persist: row.persist,
      port: server.port(),
      log: quiet,
    });
    expect(done.mediaId).toBe(stored);
    // One status read, nothing else: no part, no complete, no init.
    expect(server.seen.slice(before).map((r) => r.method)).toEqual(['GET']);
    expect(server.stored.size).toBe(1);
  });

  it('a session gone on the server (expired, swept) is reopened under the SAME key, every part again', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    const plaintext = plaintextOf();
    let puts = 0;
    server.fault = (method) => (method === 'PUT' && ++puts === 3 ? 'drop' : undefined);
    await up({
      plaintext,
      retentionClass: 'chat-reel',
      persist: row.persist,
      port: server.port(),
      log: quiet,
    }).catch(() => undefined);
    const lost = row.last!;
    server.sessions.get(lost.uploadId!)!.closed = true;
    server.fault = () => undefined;
    const done = await up({
      plaintext,
      retentionClass: 'chat-reel',
      state: lost,
      persist: row.persist,
      port: server.port(),
      log: quiet,
    });
    expect(row.last!.uploadId).not.toBe(lost.uploadId);
    expect(row.last!.keyHex).toBe(lost.keyHex);
    expect(done.keyHex).toBe(lost.keyHex);
    await decrypts(server, done.mediaId, done.keyHex, done.ivHex, plaintext);
  });

  it('a saved state for OTHER bytes (a take prepared again) is never resumed: a new key and a new session', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    const first = plaintextOf();
    let puts = 0;
    server.fault = (method) => (method === 'PUT' && ++puts === 2 ? 'drop' : undefined);
    await up({
      plaintext: first,
      retentionClass: 'chat-reel',
      persist: row.persist,
      port: server.port(),
      log: quiet,
    }).catch(() => undefined);
    const stale = row.last!;
    server.fault = () => undefined;
    const second = plaintextOf(first.length); // same length, different bytes
    second[12345] ^= 0xff;
    const lines: string[] = [];
    const done = await up({
      plaintext: second,
      retentionClass: 'chat-reel',
      state: stale,
      persist: row.persist,
      port: server.port(),
      log: (l) => lines.push(l),
    });
    expect(done.keyHex).not.toBe(stale.keyHex);
    expect(row.last!.uploadId).not.toBe(stale.uploadId);
    expect(lines.some((l) => l.includes('opened for other bytes'))).toBe(true);
    await decrypts(server, done.mediaId, done.keyHex, done.ivHex, second);
  });

  it('an abort (a teardown says "cancel" too) throws it and KEEPS the session: a withdrawal releases it, not the abort', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    const control = new AbortController();
    let puts = 0;
    server.fault = (method) => {
      if (method === 'PUT' && ++puts === 2) control.abort('cancel');
      return undefined;
    };
    const err = await up({
      plaintext: plaintextOf(),
      retentionClass: 'chat-reel',
      persist: row.persist,
      port: server.port(),
      transport: { signal: control.signal },
      log: quiet,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadAbortedError);
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    expect(server.sent.some((r) => r.method === 'DELETE')).toBe(false);
    expect(server.sessions.get(row.last!.uploadId!)!.closed).toBeUndefined();
  });

  it('releaseUploadSession DELETEs the session, and says it when the link is down instead of throwing', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    let puts = 0;
    server.fault = (method) => (method === 'PUT' && ++puts === 2 ? 'drop' : undefined);
    await up({
      plaintext: plaintextOf(),
      retentionClass: 'chat-reel',
      persist: row.persist,
      port: server.port(),
    }).catch(() => undefined);
    const id = row.last!.uploadId!;
    const lines: string[] = [];
    server.fault = (method) => (method === 'DELETE' ? 'drop' : undefined);
    expect(await releaseUploadSession(server.port(), id, 'withdrawn', (l) => lines.push(l))).toBe(
      'unanswered'
    );
    expect(lines.some((l) => l.includes('NOT released'))).toBe(true);
    server.fault = () => undefined;
    expect(await releaseUploadSession(server.port(), id, 'withdrawn', (l) => lines.push(l))).toBe(
      'answered'
    );
    expect(server.sessions.get(id)!.closed).toBe(true);
  });

  for (const where of ['GET', 'PUT', 'complete'] as const) {
    it(`an EDGE 404 on ${where} (a non-JSON page during a deploy) is not "session gone": thrown, retried, the session kept and resumed`, async () => {
      const server = new FakeSessionServer();
      const row = rowStore();
      const plaintext = plaintextOf();
      let puts = 0;
      // A first attempt cut on part 2, so there is a session to resume.
      server.fault = (method) => (method === 'PUT' && ++puts === 2 ? 'drop' : undefined);
      await up({
        plaintext,
        retentionClass: 'chat-reel',
        persist: row.persist,
        port: server.port(),
      }).catch(() => undefined);
      const state = row.last!;
      server.fault = (method, path) =>
        (where === 'GET' && method === 'GET') ||
        (where === 'PUT' && method === 'PUT') ||
        (where === 'complete' && path.endsWith('/complete'))
          ? { edge: 404 }
          : undefined;
      const err = await up({
        plaintext,
        retentionClass: 'chat-reel',
        state,
        persist: row.persist,
        port: server.port(),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MediaUploadError);
      expect((err as MediaUploadError).origin).toBe('edge');
      expect((err as MediaUploadError).sessionLost).toBe(false);
      expect(uploadRefusalCause(err)).toBeNull();
      // Never reopened: one init, one reservation, the same session recorded.
      expect(server.reservations).toBe(1);
      expect(row.last!.uploadId).toBe(state.uploadId);
      expect(server.sent.some((r) => r.method === 'DELETE')).toBe(false);
      server.fault = () => undefined;
      const done = await up({
        plaintext,
        retentionClass: 'chat-reel',
        state: row.last,
        persist: row.persist,
        port: server.port(),
      });
      expect(server.reservations).toBe(1);
      await decrypts(server, done.mediaId, done.keyHex, done.ivHex, plaintext);
    });
  }

  it('an edge 409 on a part is retried as an edge answer, never read as "being completed"', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    let puts = 0;
    server.fault = (method) => (method === 'PUT' && ++puts === 2 ? { edge: 409 } : undefined);
    const lines: string[] = [];
    const err = await up({
      plaintext: plaintextOf(),
      retentionClass: 'chat-reel',
      persist: row.persist,
      port: server.port(),
      log: (l) => lines.push(l),
    }).catch((e: unknown) => e);
    expect((err as MediaUploadError).origin).toBe('edge');
    expect(lines.some((l) => l.includes('re-reading the session'))).toBe(false);
  });

  it('a "retry" abort keeps the session: the next attempt resumes it', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    const control = new AbortController();
    let puts = 0;
    server.fault = (method) => {
      if (method === 'PUT' && ++puts === 3) control.abort('retry');
      return undefined;
    };
    await up({
      plaintext: plaintextOf(),
      retentionClass: 'chat-reel',
      persist: row.persist,
      port: server.port(),
      transport: { signal: control.signal },
      log: quiet,
    }).catch(() => undefined);
    expect(server.sent.some((r) => r.method === 'DELETE')).toBe(false);
    server.fault = () => undefined;
    await up({
      plaintext: plaintextOf(),
      retentionClass: 'chat-reel',
      state: row.last,
      persist: row.persist,
      port: server.port(),
      log: quiet,
    });
    expect(server.reservations).toBe(1);
  });

  it('a refusal for good (422) is typed at the throw and releases the session', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    server.fault = (method, path) =>
      method === 'POST' && path.endsWith('/complete') ? 422 : undefined;
    const err = await up({
      plaintext: plaintextOf(),
      retentionClass: 'chat-reel',
      persist: row.persist,
      port: server.port(),
      log: quiet,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaUploadError);
    expect(uploadRefusalCause(err)).toBe('refused');
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    expect(server.sent.some((r) => r.method === 'DELETE')).toBe(true);
  });

  it('a 5xx keeps the session: an answer a later attempt may see change', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    let puts = 0;
    server.fault = (method) => (method === 'PUT' && ++puts === 2 ? 503 : undefined);
    const err = await up({
      plaintext: plaintextOf(),
      retentionClass: 'chat-reel',
      persist: row.persist,
      port: server.port(),
      log: quiet,
    }).catch((e: unknown) => e);
    expect(uploadRefusalCause(err)).toBeNull();
    expect(server.sent.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('another member cannot resume a session it does not own (403, refused for good)', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    let puts = 0;
    server.fault = (method) => (method === 'PUT' && ++puts === 2 ? 'drop' : undefined);
    await up({
      plaintext: plaintextOf(),
      retentionClass: 'chat-reel',
      persist: row.persist,
      port: server.port('alice'),
      log: quiet,
    }).catch(() => undefined);
    server.fault = () => undefined;
    const err = await up({
      plaintext: plaintextOf(),
      retentionClass: 'chat-reel',
      state: row.last,
      persist: row.persist,
      port: server.port('mallory'),
      log: quiet,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaUploadError);
    expect((err as MediaUploadError).status).toBe(403);
  });

  it(`a session that keeps closing under it ends as a typed "session lost" after ${RESUMABLE_MAX_ROUNDS} rounds`, async () => {
    const server = new FakeSessionServer();
    server.fault = (method, path) =>
      method === 'POST' && path.endsWith('/complete') ? 404 : undefined;
    const err = await up({
      plaintext: plaintextOf(),
      retentionClass: 'chat-reel',
      persist: rowStore().persist,
      port: server.port(),
      log: quiet,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaUploadError);
    expect((err as MediaUploadError).sessionLost).toBe(true);
    expect(uploadRefusalCause(err)).toBeNull();
  });

  it('A FLAKY LINK (a seeded third of the requests lost, either way): every attempt resumes, the blob is whole, no part is stored twice per attempt', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    const plaintext = plaintextOf(70_000);
    // Deterministic: a linear congruential sequence, never Math.random.
    let seed = 0x2f6b;
    const roll = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >> 16) % 6;
    };
    server.fault = () => {
      const r = roll();
      return r === 0 ? 'drop' : r === 1 ? 'lose-answer' : undefined;
    };
    let done: Awaited<ReturnType<typeof uploadResumable>> | null = null;
    let attempts = 0;
    while (!done && attempts < 50) {
      attempts++;
      done = await up({
        plaintext,
        retentionClass: 'chat-reel',
        state: row.last,
        persist: row.persist,
        port: server.port(),
        log: quiet,
      }).catch((e: unknown) => {
        expect(isTransportFailure(e)).toBe(true);
        return null;
      });
    }
    expect(done).not.toBeNull();
    expect(attempts).toBeGreaterThan(1);
    await decrypts(server, done!.mediaId, done!.keyHex, done!.ivHex, plaintext);
    // Only one object was ever stored, whatever the number of attempts.
    expect(server.stored.size).toBe(1);
    // A part is re-sent only when its answer was lost or it never arrived: bounded by the faults.
    const parts = Math.ceil(segmentedCiphertextLength(plaintext.length) / PART);
    const lostPuts = server.sent.filter((r) => r.method === 'PUT').length - server.partsReceived();
    expect(server.partsReceived()).toBeLessThanOrEqual(parts + lostPuts + attempts);
  });
});

describe('uploadResumable, single-block (a post photo: ONE AES-GCM block, readable by every reader)', () => {
  /** Opens a stored single-block blob the way every photo reader does (`decryptMediaBuffer`). */
  async function opensAsOneBlock(blob: Uint8Array, keyHex: string, ivHex: string) {
    const key = await crypto.subtle.importKey('raw', hexDecode(keyHex), 'AES-GCM', false, [
      'decrypt',
    ]);
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: hexDecode(ivHex) as BufferSource },
        key,
        blob as BufferSource
      )
    );
  }

  it('stores one block of plaintext + tag, declares no header, and the ref carries no encoding', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    const plaintext = plaintextOf();
    const done = await up({
      plaintext,
      encoding: 'single-block',
      retentionClass: 'archive',
      persist: row.persist,
      port: server.port(),
    });
    expect(done.encoding).toBeUndefined();
    expect(row.last!.encoding).toBe('single-block');
    const blob = server.stored.get(done.mediaId)!;
    expect(blob.length).toBe(plaintext.length + 16);
    expect(sameBytes(await opensAsOneBlock(blob, done.keyHex, done.ivHex), plaintext)).toBe(true);
  });

  it('a cut on part 3 of 4: the resume sends ONLY the parts the server lacks, and the block still opens', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    const plaintext = plaintextOf();
    let puts = 0;
    server.fault = (method) => (method === 'PUT' && ++puts === 3 ? 'drop' : undefined);
    const opts = {
      plaintext,
      encoding: 'single-block' as const,
      retentionClass: 'archive' as const,
      persist: row.persist,
    };
    const err = await up({ ...opts, port: server.port() }).catch((e: unknown) => e);
    expect(isTransportFailure(err)).toBe(true);
    const id = row.last!.uploadId!;
    // Part 1 alone, then parts 2 and 3 side by side (the second lane opens on the first commit):
    // part 3 is cut, part 2 lands, and the round ends - parts 3 and 4 are owed.
    expect(server.partsReceived(id)).toBe(2);
    server.fault = () => undefined;
    const done = await up({ ...opts, state: row.last, port: server.port() });
    expect(server.partsReceived(id)).toBe(4);
    const blob = server.stored.get(done.mediaId)!;
    expect(sameBytes(await opensAsOneBlock(blob, done.keyHex, done.ivHex), plaintext)).toBe(true);
  });

  it('never resumes a state opened under the OTHER encoding: a new key and a new session', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    const plaintext = plaintextOf();
    let puts = 0;
    server.fault = (method) => (method === 'PUT' && ++puts === 2 ? 'drop' : undefined);
    await up({
      plaintext,
      retentionClass: 'archive',
      persist: row.persist,
      port: server.port(),
    }).catch(() => undefined);
    const segmentedState = row.last!;
    server.fault = () => undefined;
    const done = await up({
      plaintext,
      encoding: 'single-block',
      state: segmentedState,
      retentionClass: 'archive',
      persist: row.persist,
      port: server.port(),
    });
    expect(done.keyHex).not.toBe(segmentedState.keyHex);
    expect(row.last!.uploadId).not.toBe(segmentedState.uploadId);
    const blob = server.stored.get(done.mediaId)!;
    expect(sameBytes(await opensAsOneBlock(blob, done.keyHex, done.ivHex), plaintext)).toBe(true);
  });
});

describe('uploadResumable, two parts in flight (2026-11-16)', () => {
  it('keeps exactly RESUMABLE_PARTS_IN_FLIGHT parts on the wire, and the blob is whole', async () => {
    const server = new FakeSessionServer();
    const inner = server.port();
    let onWire = 0;
    let most = 0;
    const port = {
      request: async (...args: Parameters<typeof inner.request>) => {
        if (args[0] !== 'PUT') return inner.request(...args);
        onWire++;
        most = Math.max(most, onWire);
        // A turn of the event loop on the wire, so a serial writer would show ONE here.
        await new Promise((r) => setTimeout(r, 0));
        try {
          return await inner.request(...args);
        } finally {
          onWire--;
        }
      },
    };
    const plaintext = plaintextOf(80_000);
    const done = await up({
      plaintext,
      retentionClass: 'chat-reel',
      persist: rowStore().persist,
      port,
    });
    expect(most).toBe(RESUMABLE_PARTS_IN_FLIGHT);
    expect(server.partsReceived()).toBe(
      Math.ceil(segmentedCiphertextLength(plaintext.length) / PART)
    );
    await decrypts(server, done.mediaId, done.keyHex, done.ivHex, plaintext);
  });

  it('seals a single block ONCE, however many parts ask for it at the same time', async () => {
    const server = new FakeSessionServer();
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt');
    try {
      await up({
        plaintext: plaintextOf(),
        encoding: 'single-block',
        retentionClass: 'ephemeral',
        persist: rowStore().persist,
        port: server.port(),
      });
      expect(encrypt).toHaveBeenCalledTimes(1);
    } finally {
      encrypt.mockRestore();
    }
  });

  it('reports committed bytes plus what is in flight, never backwards, from the server held bytes on a resume', async () => {
    const server = new FakeSessionServer();
    const row = rowStore();
    const plaintext = plaintextOf();
    let puts = 0;
    server.fault = (method) => (method === 'PUT' && ++puts === 3 ? 'drop' : undefined);
    await up({
      plaintext,
      retentionClass: 'chat-reel',
      persist: row.persist,
      port: server.port(),
    }).catch(() => undefined);
    const total = segmentedCiphertextLength(plaintext.length);
    const held = [...server.sessions.get(row.last!.uploadId!)!.received].reduce(
      (sum, i) => sum + Math.min(PART, total - i * PART),
      0
    );
    server.fault = () => undefined;
    const seen: number[] = [];
    await up({
      plaintext,
      retentionClass: 'chat-reel',
      state: row.last,
      persist: row.persist,
      port: server.port(),
      transport: { onProgress: (p) => seen.push(p.loaded) },
    });
    // The resume's first figure is what the server holds, not zero.
    expect(seen[0]).toBe(held);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen.at(-1)).toBe(total);
  });

  it('logs the rate each round committed, for a device whose console cannot be read', async () => {
    const server = new FakeSessionServer();
    const lines: string[] = [];
    await up({
      plaintext: plaintextOf(),
      retentionClass: 'chat-reel',
      persist: rowStore().persist,
      port: server.port(),
      log: (l) => lines.push(l),
    });
    expect(
      lines.some((l) => /round 1: \d+ bytes committed in \d+ ms \(\d+ KB\/s\), 4\/4 part/.test(l))
    ).toBe(true);
  });
});

describe('uploadResumable on an uplink that is cut every few seconds (review of #3661)', () => {
  /**
   * A link that moves `budget` bytes per attempt, shared by every part on the wire (1 KiB at a time,
   * a turn of the event loop each), then cuts: every request in flight and every new one fails with
   * no answer until `reconnect()`. The reviewer's case: 40 KB/s cut every 30 s is 1.2 MB a window,
   * under two 1 MiB parts.
   */
  function cuttingLink(server: FakeSessionServer, budget: number) {
    const inner = server.port();
    let left = budget;
    return {
      reconnect: () => (left = budget),
      port: {
        request: async (...args: Parameters<typeof inner.request>) => {
          const [, path, body, transport] = args;
          if (left <= 0) throw new UploadNetworkError(path);
          if (!(body instanceof Blob)) return inner.request(...args);
          for (let sent = 0; sent < body.size;) {
            await new Promise((r) => setTimeout(r, 0));
            if (left <= 0) throw new UploadNetworkError(path);
            const step = Math.min(1024, body.size - sent, left);
            sent += step;
            left -= step;
            transport?.onProgress?.({ loaded: sent, total: body.size });
          }
          return inner.request(...args);
        },
      },
    };
  }

  it('commits a part in every window of 1.2 parts, and completes - two lanes from the start never did', async () => {
    const server = new FakeSessionServer();
    const link = cuttingLink(server, Math.round(1.2 * PART));
    const row = rowStore();
    const plaintext = plaintextOf();
    const parts = Math.ceil(segmentedCiphertextLength(plaintext.length) / PART);
    let done: Awaited<ReturnType<typeof up>> | null = null;
    let held = 0;
    for (let attempt = 1; attempt <= parts + 1 && !done; attempt++) {
      link.reconnect();
      try {
        done = await up({
          plaintext,
          retentionClass: 'chat-reel',
          state: row.last,
          persist: row.persist,
          port: link.port,
        });
      } catch (e) {
        expect(e).toBeInstanceOf(UploadNetworkError);
        // EVERY CUT WINDOW COMMITTED A PART: the progress the outbox's give-up count looks for.
        const now = server.sessions.get(row.last!.uploadId!)!.received.size;
        expect(now).toBeGreaterThan(held);
        held = now;
      }
    }
    expect(done).not.toBeNull();
    await decrypts(server, done!.mediaId, done!.keyHex, done!.ivHex, plaintext);
  });
});

describe('uploadResumable gives back a session it stops using (review of #3661)', () => {
  /** Opens a session with part 1 cut, so a state with a live uploadId is left in the row. */
  async function leftOpen(server: FakeSessionServer, plaintext: Uint8Array) {
    const row = rowStore();
    let puts = 0;
    server.fault = (method) => (method === 'PUT' && ++puts === 1 ? 'drop' : undefined);
    await up({
      plaintext,
      retentionClass: 'archive',
      persist: row.persist,
      port: server.port(),
    }).catch(() => undefined);
    server.fault = () => undefined;
    return row;
  }

  it('a state opened for OTHER bytes: its session is released, and a new one completes', async () => {
    const server = new FakeSessionServer();
    const row = await leftOpen(server, plaintextOf());
    const old = row.last!.uploadId!;
    await up({
      plaintext: plaintextOf(30_000),
      retentionClass: 'archive',
      state: row.last,
      persist: row.persist,
      port: server.port(),
    });
    expect(server.sessions.get(old)!.closed).toBe(true);
    expect(row.last!.uploadId).not.toBe(old);
  });

  it('a state opened under the other ENCODING: its session is released', async () => {
    const server = new FakeSessionServer();
    const plaintext = plaintextOf();
    const row = await leftOpen(server, plaintext);
    const old = row.last!.uploadId!;
    await up({
      plaintext,
      encoding: 'single-block',
      retentionClass: 'archive',
      state: row.last,
      persist: row.persist,
      port: server.port(),
    });
    expect(server.sessions.get(old)!.closed).toBe(true);
  });

  it('a session the server still has but that does not match these bytes is released before reopening', async () => {
    const server = new FakeSessionServer();
    const plaintext = plaintextOf();
    const row = await leftOpen(server, plaintext);
    const old = row.last!.uploadId!;
    // The server's fact disagrees with the saved state (another part size).
    const done = await up({
      plaintext,
      retentionClass: 'archive',
      state: { ...row.last!, partBytes: PART * 2 },
      persist: row.persist,
      port: server.port(),
    });
    expect(server.sessions.get(old)!.closed).toBe(true);
    await decrypts(server, done.mediaId, done.keyHex, done.ivHex, plaintext);
  });
});
