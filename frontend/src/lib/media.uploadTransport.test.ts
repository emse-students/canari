/**
 * AN UPLOAD THAT IS GIVEN A TRANSPORT REPORTS ITS BYTES AND CAN BE STOPPED (WP-OFF-8).
 *
 * `fetch` exposes no upload progress, so a bubble could only spin. With `transport` the same
 * request goes through `xhrUpload`; without it nothing changes (the 401 tests beside this one pin
 * that path). Pinned: progress arrives, a 401 renews the token and resends through the SAME
 * transport, and a cancel reaches the request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshMock = vi.fn();
vi.mock('$lib/stores/auth', () => ({
  getToken: () => Promise.resolve('token'),
  refresh: () => refreshMock(),
  SessionExpiredError: class extends Error {},
}));
vi.mock('$lib/utils/mediaTouch', () => ({ noteMediaCacheHit: () => {} }));

class FakeXhr {
  static all: FakeXhr[] = [];
  upload: { onprogress: ((e: unknown) => void) | null; onload: (() => void) | null } = {
    onprogress: null,
    onload: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  responseType = '';
  status = 0;
  statusText = '';
  responseText = '';
  headers: Record<string, string> = {};
  aborted = false;
  constructor() {
    FakeXhr.all.push(this);
  }
  open() {}
  contentType: string | null = 'application/json';
  getResponseHeader(name: string) {
    return name.toLowerCase() === 'content-type' ? this.contentType : null;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send() {}
  abort() {
    this.aborted = true;
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total, lengthComputable: true });
  }
  answer(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

const { MediaService } = await import('$lib/media');
const { UploadAbortedError } = await import('$lib/utils/uploadXhr');

const file = () => new File([new Uint8Array(64)], 'p.bin', { type: 'application/octet-stream' });
/** Encryption is asynchronous, so the request exists some milliseconds after the call. */
const requestCount = (n: number) => vi.waitFor(() => expect(FakeXhr.all.length).toBe(n));

describe('media upload with a transport', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    FakeXhr.all = [];
    fetchMock.mockReset();
    refreshMock.mockReset();
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    vi.stubGlobal('fetch', fetchMock);
  });

  it('reports progress and never touches fetch', async () => {
    const seen: number[] = [];
    const p = new MediaService().encryptAndUpload(file(), 'tok', undefined, 'ephemeral', {
      onProgress: ({ loaded }) => seen.push(loaded),
    });
    await requestCount(1);
    const xhr = FakeXhr.all[0];
    xhr.progress(10, 80);
    xhr.progress(80, 80);
    xhr.answer(201, { mediaId: 'm1' });

    expect((await p).mediaId).toBe('m1');
    expect(seen).toEqual([10, 80]);
    expect(xhr.headers.Authorization).toBe('Bearer tok');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 401 renews the token and resends through the same transport', async () => {
    refreshMock.mockResolvedValue('fresh');
    const p = new MediaService().encryptAndUpload(file(), 'stale', undefined, 'ephemeral', {
      onProgress: () => {},
    });
    await requestCount(1);
    FakeXhr.all[0].answer(401, {});
    await requestCount(2);
    FakeXhr.all[1].answer(201, { mediaId: 'm2' });

    expect((await p).mediaId).toBe('m2');
    expect(FakeXhr.all[1].headers.Authorization).toBe('Bearer fresh');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a cancel reaches the request on the wire', async () => {
    const control = new AbortController();
    const p = new MediaService().encryptAndUpload(file(), 'tok', undefined, 'ephemeral', {
      signal: control.signal,
    });
    const settled = p.catch((e: unknown) => e);
    await requestCount(1);
    control.abort('cancel');

    expect(await settled).toBeInstanceOf(UploadAbortedError);
    expect(FakeXhr.all[0].aborted).toBe(true);
  });
});
