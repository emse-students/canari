/**
 * NO REQUEST BODY CAN EXCEED THE HOST WAF'S LIMIT (10 MiB, measured 2026-10-10).
 *
 * A 13.4 MB PDF went up as ONE body, the school-managed CrowdSec AppSec in front of production
 * dropped it, and the client read a 403 ban page as "transient" and retried for ever. Every upload
 * body is now at most 8 MiB: a bigger file takes the chunked route. This test sends files around the
 * budget through the real `MediaService` and measures what each request carried.
 * docs/wiki/infrastructure/host-waf-body-limit.md
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/auth', () => ({
  getToken: () => Promise.resolve('token'),
  refresh: () => Promise.resolve('fresh'),
  SessionExpiredError: class extends Error {},
}));
vi.mock('$lib/utils/mediaTouch', () => ({ noteMediaCacheHit: () => {} }));

const sent: Array<{ url: string; bytes: number }> = [];

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
  url = '';
  open(_m: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  getResponseHeader() {
    return 'application/json';
  }
  abort() {}
  send(body: unknown) {
    let bytes = 0;
    if (body instanceof FormData) {
      for (const v of body.values()) bytes += typeof v === 'string' ? v.length : v.size;
    }
    sent.push({ url: this.url, bytes });
    queueMicrotask(() => this.onload?.());
  }
}

const { MediaService } = await import('$lib/media');
const { GATEWAY_MAX_BODY_BYTES, MEDIA_REQUEST_BODY_BUDGET_BYTES } =
  await import('$lib/utils/mediaRequestLimits');

const fileOf = (bytes: number) =>
  new File([new Uint8Array(bytes)], 'big.pdf', { type: 'application/pdf' });

describe('media upload request bodies', () => {
  beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({ url, bytes: 0 });
      void init;
      return new Response('{"uploadId":"u1","mediaId":"m1"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  it('keeps the budget safely under what the host drops', () => {
    expect(MEDIA_REQUEST_BODY_BUDGET_BYTES).toBeLessThan(GATEWAY_MAX_BODY_BYTES);
    expect(GATEWAY_MAX_BODY_BYTES - MEDIA_REQUEST_BODY_BUDGET_BYTES).toBeGreaterThanOrEqual(
      1024 * 1024
    );
  });

  it('a small file is ONE request', async () => {
    await new MediaService().encryptAndUpload(fileOf(1_000_000), 't', undefined, 'ephemeral', {});
    expect(sent.map((s) => s.url.split('/api/media')[1])).toEqual(['/upload']);
  });

  it.each([
    MEDIA_REQUEST_BODY_BUDGET_BYTES - 16,
    MEDIA_REQUEST_BODY_BUDGET_BYTES,
    14_049_945,
    30_000_000,
  ])(
    'a %i byte file never sends a body over the budget',
    async (size) => {
      await new MediaService().encryptAndUpload(fileOf(size), 't', undefined, 'ephemeral', {});
      const bodies = sent.filter((s) => s.bytes > 0);
      expect(bodies.length).toBeGreaterThan(0);
      for (const b of bodies)
        expect(b.bytes).toBeLessThanOrEqual(MEDIA_REQUEST_BODY_BUDGET_BYTES + 4096);
      // Everything reached the server, whatever the split.
      const carried = bodies
        .filter((b) => !b.url.endsWith('/complete'))
        .reduce((n, b) => n + b.bytes, 0);
      expect(carried).toBeGreaterThanOrEqual(size);
    },
    60_000
  );

  it('the 14 MB PDF of the report goes through the chunk route, in two chunks', async () => {
    await new MediaService().encryptAndUpload(fileOf(14_049_945), 't', undefined, 'ephemeral', {});
    const route = sent.map((s) => s.url.split('/api/media')[1].replace(/u1/, ':id'));
    expect(route).toEqual([
      '/upload/chunk/init',
      '/upload/chunk/:id',
      '/upload/chunk/:id',
      '/upload/chunk/:id/complete',
    ]);
  });
});
