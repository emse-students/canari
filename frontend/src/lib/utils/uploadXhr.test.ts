import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTransportFailure } from '$lib/stores/connectivity.svelte';
import { UploadAbortedError, UploadStalledError, xhrUpload } from './uploadXhr';

/** The slice of XMLHttpRequest the transport uses, drivable from a test. */
class FakeXhr {
  static last: FakeXhr;
  upload: {
    onprogress: ((e: unknown) => void) | null;
    onload: (() => void) | null;
  } = { onprogress: null, onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  responseType = '';
  status = 0;
  statusText = '';
  responseText = '';
  headers: Record<string, string> = {};
  aborted = false;
  sent: unknown = undefined;
  constructor() {
    FakeXhr.last = this;
  }
  open() {}
  contentType: string | null = 'application/json';
  getResponseHeader(name: string) {
    return name.toLowerCase() === 'content-type' ? this.contentType : null;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.sent = body;
  }
  abort() {
    this.aborted = true;
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total, lengthComputable: true });
  }
  answer(status: number, text: string) {
    this.status = status;
    this.statusText = status === 200 ? 'OK' : 'ERR';
    this.responseText = text;
    this.upload.onload?.();
    this.onload?.();
  }
}

describe('xhrUpload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports the bytes sent and resolves with a Response a fetch caller can read', async () => {
    const seen: Array<[number, number]> = [];
    const p = xhrUpload(
      'https://x.test/api/media/upload',
      { headers: { Authorization: 'Bearer t' }, body: 'payload' },
      { onProgress: ({ loaded, total }) => seen.push([loaded, total]) }
    );
    const xhr = FakeXhr.last;
    xhr.progress(10, 100);
    xhr.progress(60, 100);
    xhr.answer(200, '{"mediaId":"m1"}');

    const res = await p;
    expect(seen).toEqual([
      [10, 100],
      [60, 100],
    ]);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ mediaId: 'm1' });
    expect(xhr.headers.Authorization).toBe('Bearer t');
    expect(xhr.sent).toBe('payload');
  });

  it('hands a refusal back as a status, never as an exception', async () => {
    const p = xhrUpload('https://x.test/u', { body: 'x' });
    FakeXhr.last.answer(413, 'too big');
    const res = await p;
    expect(res.status).toBe(413);
    expect(await res.text()).toBe('too big');
  });

  it('a network error is the TypeError fetch would have thrown, so it reads as a transport failure', async () => {
    const p = xhrUpload('https://x.test/u', { body: 'x' });
    FakeXhr.last.onerror?.();
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(isTransportFailure(err)).toBe(true);
  });

  it('gives up on SILENCE, not on a total: steady progress outlives the idle window', async () => {
    const p = xhrUpload('https://x.test/u', { body: 'x' }, { idleMs: 1_000 });
    const xhr = FakeXhr.last;
    // Ten seconds in total, but a byte moves every 800 ms: never idle for the full window.
    for (let i = 1; i <= 12; i++) {
      vi.advanceTimersByTime(800);
      xhr.progress(i, 12);
    }
    expect(xhr.aborted).toBe(false);
    xhr.answer(200, '{}');
    await expect(p).resolves.toBeInstanceOf(Response);
  });

  it('abandons a transfer that moved no byte for the idle window, typed as a transport failure', async () => {
    const p = xhrUpload('https://x.test/api/media/upload', { body: 'abc' }, { idleMs: 1_000 });
    const xhr = FakeXhr.last;
    xhr.progress(1, 3);
    vi.advanceTimersByTime(1_001);

    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadStalledError);
    expect(isTransportFailure(err)).toBe(true);
    expect(xhr.aborted).toBe(true);
  });

  it('a caller cancel aborts the request and is NOT a transport failure', async () => {
    const control = new AbortController();
    const p = xhrUpload('https://x.test/u', { body: 'x' }, { signal: control.signal });
    control.abort('cancel');

    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadAbortedError);
    expect((err as UploadAbortedError).reason).toBe('cancel');
    expect(FakeXhr.last.aborted).toBe(true);
    expect(isTransportFailure(err)).toBe(false);
  });

  it('refuses to start when already cancelled', async () => {
    const control = new AbortController();
    control.abort('retry');
    const err = await xhrUpload(
      'https://x.test/u',
      { body: 'x' },
      { signal: control.signal }
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadAbortedError);
  });
});
