/**
 * THE LEGACY CHUNK SESSION IS GIVEN BACK WHEN AN ATTEMPT ENDS WITHOUT AN OBJECT (WP-OFF-8 review,
 * 2026-10-10), and a slow server-side `complete` is never mistaken for silence.
 *
 * WHY. Every failed attempt restarts under a NEW uploadId, so the bytes staged by the previous one
 * were stranded until the 24 h sweep. Drives the real `MediaService` chunk loop with a fake transport
 * that fails at chunk N, refuses, is cancelled, or answers `complete` slowly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestBodyBytes } from '$lib/utils/mediaRequestLimits';

vi.mock('$lib/stores/auth', () => ({
  getToken: () => Promise.resolve('token'),
  refresh: () => Promise.resolve('fresh'),
  SessionExpiredError: class extends Error {},
}));
vi.mock('$lib/utils/mediaTouch', () => ({ noteMediaCacheHit: () => {} }));

type Plan = { status: number; contentType?: string; failNetwork?: boolean; delayMs?: number };
let plan: (url: string, index: number) => Plan;
const calls: string[] = [];
const deletes: string[] = [];
let chunkIndex = 0;

class FakeXhr {
  upload: { onprogress: ((e: unknown) => void) | null; onload: (() => void) | null } = {
    onprogress: null,
    onload: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  responseType = '';
  status = 200;
  statusText = 'OK';
  responseText = '{"mediaId":"m1","uploadId":"u1"}';
  contentType = 'application/json';
  url = '';
  open(_m: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  getResponseHeader() {
    return this.contentType;
  }
  abort() {}
  send() {
    const isChunk = this.url.endsWith('/chunk/u1');
    const p = plan(this.url, isChunk ? chunkIndex++ : -1);
    calls.push(this.url.split('/api/media')[1]);
    this.upload.onload?.();
    const answer = () => {
      if (p.failNetwork) return this.onerror?.();
      this.status = p.status;
      this.contentType = p.contentType ?? 'application/json';
      if (p.status !== 200) this.responseText = '{"message":"no"}';
      this.onload?.();
    };
    setTimeout(answer, p.delayMs ?? 0);
  }
}

const { MediaService } = await import('$lib/media');
const { UploadAbortedError } = await import('$lib/utils/uploadXhr');
const { uploadRefusalCause } = await import('$lib/utils/mediaErrors');

const THREE_CHUNKS = 20_000_000;
const fileOf = (bytes: number) =>
  new File([new Uint8Array(bytes)], 'big.pdf', { type: 'application/pdf' });

describe('a chunked upload that ends without an object', () => {
  beforeEach(() => {
    calls.length = 0;
    deletes.length = 0;
    chunkIndex = 0;
    plan = () => ({ status: 200 });
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') deletes.push(url.split('/api/media')[1]);
      return new Response('', { status: 204 });
    });
  });

  it('releases the session when the transport fails at chunk 2 of 3, and the failure still surfaces', async () => {
    plan = (_u, i) => (i === 1 ? { status: 0, failNetwork: true } : { status: 200 });
    const err = await new MediaService()
      .encryptAndUpload(fileOf(THREE_CHUNKS), 't', undefined, 'ephemeral', {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(uploadRefusalCause(err)).toBeNull(); // a network error is retried, not refused
    await vi.waitFor(() => expect(deletes).toEqual(['/upload/chunk/u1']));
    expect(calls.filter((c) => c === '/upload/chunk/u1')).toHaveLength(2);
    expect(calls).not.toContain('/upload/chunk/u1/complete');
  });

  it('releases the session on a refusal, which is final', async () => {
    plan = (_u, i) => (i === 0 ? { status: 422 } : { status: 200 });
    const err = await new MediaService()
      .encryptAndUpload(fileOf(THREE_CHUNKS), 't', undefined, 'ephemeral', {})
      .catch((e: unknown) => e);
    expect(uploadRefusalCause(err)).toBe('refused');
    await vi.waitFor(() => expect(deletes).toEqual(['/upload/chunk/u1']));
  });

  it('a session the server lost (404 on a chunk) is retried, not refused', async () => {
    plan = (_u, i) => (i === 1 ? { status: 404 } : { status: 200 });
    const err = await new MediaService()
      .encryptAndUpload(fileOf(THREE_CHUNKS), 't', undefined, 'ephemeral', {})
      .catch((e: unknown) => e);
    expect(uploadRefusalCause(err)).toBeNull();
  });

  it('releases the session on a cancel', async () => {
    const control = new AbortController();
    plan = (_u, i) => {
      if (i === 0) queueMicrotask(() => control.abort('cancel'));
      return { status: 200, delayMs: 5 };
    };
    const err = await new MediaService()
      .encryptAndUpload(fileOf(THREE_CHUNKS), 't', undefined, 'ephemeral', {
        signal: control.signal,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadAbortedError);
    await vi.waitFor(() => expect(deletes).toEqual(['/upload/chunk/u1']));
  });

  it('a slow server-side complete is not abandoned as silence, and nothing is released', async () => {
    plan = (url) => (url.endsWith('/complete') ? { status: 200, delayMs: 300 } : { status: 200 });
    const ref = await new MediaService().encryptAndUpload(
      fileOf(THREE_CHUNKS),
      't',
      undefined,
      'ephemeral',
      { idleMs: 50, answerMs: 5_000 }
    );
    expect(ref.mediaId).toBe('m1');
    expect(deletes).toEqual([]);
    expect(calls.at(-1)).toBe('/upload/chunk/u1/complete');
  });

  it('a success releases nothing', async () => {
    await new MediaService().encryptAndUpload(
      fileOf(THREE_CHUNKS),
      't',
      undefined,
      'ephemeral',
      {}
    );
    expect(deletes).toEqual([]);
  });
});

describe('requestBodyBytes fails closed', () => {
  it('measures the known shapes', () => {
    expect(requestBodyBytes(null)).toBe(0);
    expect(requestBodyBytes('abc')).toBe(3);
    expect(requestBodyBytes(new Blob([new Uint8Array(10)]))).toBe(10);
    expect(requestBodyBytes(new URLSearchParams({ a: 'bc' }))).toBe(4);
  });

  it('counts an unknown body (a stream) as over every budget, never as zero', () => {
    const stream = new ReadableStream() as unknown as BodyInit;
    expect(requestBodyBytes(stream)).toBe(Number.POSITIVE_INFINITY);
  });
});
