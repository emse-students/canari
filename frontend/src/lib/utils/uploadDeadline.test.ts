import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UPLOAD_ANSWER_BASE_MS,
  fetchWithAnswerDeadline,
  uploadBodyBytes,
  uploadDeadlineMs,
} from './uploadDeadline';
import { UploadAnswerTimeoutError } from './uploadXhr';

afterEach(() => vi.useRealTimers());

describe('uploadDeadlineMs', () => {
  it('is the answer allowance for an empty body and grows with the size, deterministically', () => {
    expect(uploadDeadlineMs(0)).toBe(UPLOAD_ANSWER_BASE_MS);
    expect(uploadDeadlineMs(16 * 1024)).toBe(UPLOAD_ANSWER_BASE_MS + 1000);
    expect(uploadDeadlineMs(1_000_000)).toBe(uploadDeadlineMs(1_000_000));
  });
});

describe('uploadBodyBytes', () => {
  it('counts blobs, buffers and the blob parts of a FormData', () => {
    const form = new FormData();
    form.append('chunk', new Blob([new Uint8Array(10)]), 'c');
    expect(uploadBodyBytes(new Blob([new Uint8Array(7)]))).toBe(7);
    expect(uploadBodyBytes(new Uint8Array(5))).toBe(5);
    expect(uploadBodyBytes(form)).toBe(10);
    expect(uploadBodyBytes(null)).toBe(0);
  });
});

describe('fetchWithAnswerDeadline', () => {
  it('returns the answer when one comes, including a 413', async () => {
    const send = vi.fn(async () => new Response('', { status: 413 }));
    const res = await fetchWithAnswerDeadline(
      'https://a.test/x',
      { method: 'POST' },
      send as never
    );
    expect(res.status).toBe(413);
  });

  it('aborts a request nobody answers and throws the TYPED error', async () => {
    vi.useFakeTimers();
    const send = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('x', 'AbortError'))
          );
        })
    );
    const body = new Blob([new Uint8Array(16 * 1024)]);
    const pending = fetchWithAnswerDeadline(
      'https://a.test/x',
      { method: 'POST', body },
      send as never
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(UploadAnswerTimeoutError);
    await vi.advanceTimersByTimeAsync(uploadDeadlineMs(16 * 1024));
    await assertion;
  });

  it('lets a network failure through untouched, never retyped as a timeout', async () => {
    const boom = new TypeError('failed');
    const send = vi.fn(async () => {
      throw boom;
    });
    await expect(fetchWithAnswerDeadline('https://a.test/x', {}, send as never)).rejects.toBe(boom);
  });
});
