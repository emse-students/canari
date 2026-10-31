/**
 * THE LIVES CLIENT AGAINST THE SERVER'S REAL ANSWERS (apps/social-service/src/lives/).
 *
 * Pinned: every route's method, URL and body; every refusal typed at the throw with its kind and
 * extras - LIVE_FULL, LIVE_SEATS_UNAVAILABLE and 429 never confusable; a transport failure never
 * wrapped as a refusal; the segment fetch sends no token and no custom header; the uploader sends
 * in index order, retries the same index, and stops on a verdict.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
const trackedFetch = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
vi.mock('$lib/utils/trackedFetch', () => ({ trackedFetch }));
vi.mock('$lib/utils/apiUrl', () => ({
  socialUrl: () => 'https://social.test',
  mediaUrl: () => 'https://media.test',
}));

import {
  classifyLiveRefusal,
  cutLive,
  endLive,
  fetchLive,
  fetchLiveLimits,
  fetchLiveRules,
  fetchLiveManifest,
  fetchLiveSegment,
  isLiveCut,
  hideLiveMessage,
  isLiveRefusal,
  leaveLiveSeat,
  listOpenLives,
  LiveRefusalError,
  LiveSegmentUploader,
  liveSegmentUrl,
  manifestQuery,
  postLiveMessage,
  postLiveReactions,
  putLiveSegment,
  removeLiveViewer,
  startLive,
} from './api';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { refusalCode } from '$lib/utils/apiRefusal';
import { TransportFailureError } from '$lib/utils/transportFailure';

const LIVE = '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';
const KEY = 'ab'.repeat(32);

/** A gateway answer: JSON, as Nest and nginx's API errors send it. */
const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** An edge page: HTML, no code. */
const html = (status: number) =>
  new Response('<html>nope</html>', { status, headers: { 'content-type': 'text/html' } });

async function refusal(p: Promise<unknown>): Promise<LiveRefusalError> {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(LiveRefusalError);
  return e as LiveRefusalError;
}

beforeEach(() => {
  apiFetch.mockReset();
  trackedFetch.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('the routes', () => {
  it('limits and list are GETs on /api/lives', async () => {
    apiFetch.mockResolvedValueOnce(json(200, { viewerCap: 24, seatLeaseMs: 30000 }));
    expect((await fetchLiveLimits()).viewerCap).toBe(24);
    expect(apiFetch).toHaveBeenLastCalledWith('https://social.test/api/lives/limits', {});

    apiFetch.mockResolvedValueOnce(json(200, [{ id: LIVE }]));
    expect(await listOpenLives()).toEqual([{ id: LIVE }]);
    expect(apiFetch).toHaveBeenLastCalledWith('https://social.test/api/lives', {});
  });

  it('start POSTs the key, and the association only when given', async () => {
    apiFetch.mockImplementation(async () => json(201, { id: LIVE, key: KEY }));
    await startLive(KEY);
    expect(apiFetch).toHaveBeenLastCalledWith('https://social.test/api/lives', {
      method: 'POST',
      body: JSON.stringify({ key: KEY }),
    });
    await startLive(KEY, 'asso-1');
    expect(JSON.parse(apiFetch.mock.lastCall![1].body)).toEqual({
      key: KEY,
      associationId: 'asso-1',
    });
    await startLive(KEY, undefined, 1);
    expect(JSON.parse(apiFetch.mock.lastCall![1].body)).toEqual({
      key: KEY,
      acceptedRulesVersion: 1,
    });
  });

  it('the rules standing is a GET on /api/lives/rules; its refusal at the start is typed', async () => {
    apiFetch.mockResolvedValueOnce(
      json(200, { version: 1, acceptedVersion: null, acceptedAt: null })
    );
    expect(await fetchLiveRules()).toEqual({ version: 1, acceptedVersion: null, acceptedAt: null });
    expect(apiFetch).toHaveBeenLastCalledWith('https://social.test/api/lives/rules', {});
    apiFetch.mockResolvedValueOnce(json(403, { code: 'LIVE_RULES_NOT_ACCEPTED', rulesVersion: 1 }));
    const refused = await refusal(startLive(KEY));
    expect(refused).toMatchObject({ code: 'LIVE_RULES_NOT_ACCEPTED', kind: 'refused' });
  });

  it('the start never logs the key', async () => {
    apiFetch.mockResolvedValue(json(201, { id: LIVE, key: KEY }));
    await startLive(KEY);
    const logged = [console.debug, console.log, console.warn]
      .flatMap((f) => vi.mocked(f).mock.calls.flat())
      .join(' ');
    expect(logged).not.toContain(KEY);
  });

  it('open, manifest (with and without from), end, leave, remove', async () => {
    apiFetch.mockResolvedValueOnce(json(200, { id: LIVE, key: KEY }));
    await fetchLive(LIVE);
    expect(apiFetch).toHaveBeenLastCalledWith(`https://social.test/api/lives/${LIVE}`, {});

    apiFetch.mockResolvedValueOnce(json(200, { segments: [] }));
    await fetchLiveManifest(LIVE);
    expect(apiFetch.mock.lastCall![0]).toBe(`https://social.test/api/lives/${LIVE}/manifest`);
    apiFetch.mockResolvedValueOnce(json(200, { segments: [] }));
    await fetchLiveManifest(LIVE, 0);
    expect(apiFetch.mock.lastCall![0]).toBe(
      `https://social.test/api/lives/${LIVE}/manifest?from=0`
    );

    apiFetch.mockResolvedValueOnce(json(200, { id: LIVE, endReason: 'broadcaster' }));
    expect((await endLive(LIVE)).endReason).toBe('broadcaster');
    expect(apiFetch).toHaveBeenLastCalledWith(`https://social.test/api/lives/${LIVE}/end`, {
      method: 'POST',
    });

    apiFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await leaveLiveSeat(LIVE);
    expect(apiFetch).toHaveBeenLastCalledWith(`https://social.test/api/lives/${LIVE}/seat`, {
      method: 'DELETE',
    });

    apiFetch.mockResolvedValueOnce(json(200, { liveId: LIVE, viewerId: 'u2' }));
    await removeLiveViewer(LIVE, 'u2');
    expect(apiFetch).toHaveBeenLastCalledWith(
      `https://social.test/api/lives/${LIVE}/removed-viewers`,
      { method: 'POST', body: JSON.stringify({ viewerId: 'u2' }) }
    );
  });

  it('a cut is a POST with the reason, and the details only when given', async () => {
    const answer = {
      liveId: LIVE,
      broadcasterId: 'u9',
      reason: 'spam',
      cutAt: '2026-10-19T10:00:00.000Z',
      endReason: 'cut',
      newlyCut: true,
      priorCuts: 2,
    };
    apiFetch.mockImplementation(async () => json(200, answer));
    expect(await cutLive(LIVE, 'spam')).toEqual(answer);
    expect(apiFetch).toHaveBeenLastCalledWith(`https://social.test/api/lives/${LIVE}/cut`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'spam' }),
    });
    await cutLive(LIVE, 'other', 'why');
    expect(apiFetch).toHaveBeenLastCalledWith(`https://social.test/api/lives/${LIVE}/cut`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'other', details: 'why' }),
    });
  });

  it('a cut refusal keeps its code: forbidden and invalid are refused, a missing live not-found', async () => {
    apiFetch.mockResolvedValueOnce(json(403, { code: 'LIVE_CUT_FORBIDDEN' }));
    const forbidden = await refusal(cutLive(LIVE, 'spam'));
    expect([forbidden.kind, forbidden.code]).toEqual(['refused', 'LIVE_CUT_FORBIDDEN']);
    apiFetch.mockResolvedValueOnce(json(400, { code: 'LIVE_CUT_REASON_INVALID' }));
    expect((await refusal(cutLive(LIVE, 'spam'))).code).toBe('LIVE_CUT_REASON_INVALID');
    apiFetch.mockResolvedValueOnce(json(404, { code: 'LIVE_NOT_FOUND' }));
    expect((await refusal(cutLive(LIVE, 'spam'))).kind).toBe('not-found');
  });

  it('a segment is a raw octet-stream PUT at its index', async () => {
    apiFetch.mockResolvedValue(json(200, { index: 3, name: 'n', nextIndex: 4 }));
    const sealed = new Uint8Array([1, 2, 3]);
    expect(await putLiveSegment(LIVE, 3, sealed)).toEqual({ index: 3, name: 'n', nextIndex: 4 });
    const [url, init] = apiFetch.mock.lastCall!;
    expect(url).toBe(`https://social.test/api/lives/${LIVE}/segments/3`);
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
    expect(init.body).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (init.body as Blob).arrayBuffer())).toEqual(sealed);
  });

  it('the segment fetch is a plain GET: no token, no custom header, canonical lower case', async () => {
    trackedFetch.mockResolvedValue(new Response(new Uint8Array([9, 9]), { status: 200 }));
    const bytes = await fetchLiveSegment(LIVE.toUpperCase(), 'ABC');
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([9, 9]));
    expect(trackedFetch).toHaveBeenCalledWith(
      fetch,
      `https://media.test/api/media/public/live/${LIVE}/abc`,
      { method: 'GET' }
    );
    expect(apiFetch).not.toHaveBeenCalled();
    expect(liveSegmentUrl(LIVE, 'n')).toBe(`https://media.test/api/media/public/live/${LIVE}/n`);
  });

  it("the segment fetch carries the caller's signal, and nothing else is added for it", async () => {
    trackedFetch.mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    const ctrl = new AbortController();
    await fetchLiveSegment(LIVE, 'abc', ctrl.signal);
    const [, , init] = trackedFetch.mock.lastCall!;
    expect(init).toEqual({ method: 'GET', signal: ctrl.signal });
    expect(Object.keys(init).sort()).toEqual(['method', 'signal']);
  });
});

describe('refusals, typed at the throw', () => {
  it('LIVE_FULL is its own kind and carries the cap', async () => {
    apiFetch.mockResolvedValue(json(503, { code: 'LIVE_FULL', viewerCap: 24 }));
    const e = await refusal(fetchLive(LIVE));
    expect(e.kind).toBe('full');
    expect(e.viewerCap).toBe(24);
    expect(e.status).toBe(503);
    expect(refusalCode(e)).toBe('LIVE_FULL');
    expect(e).toBeInstanceOf(ApiRefusalError);
    expect(isLiveRefusal(e, 'full')).toBe(true);
  });

  it('LIVE_SEATS_UNAVAILABLE, a coded 429, and nginx 429 are three answers no screen can confuse', async () => {
    apiFetch.mockResolvedValueOnce(json(503, { code: 'LIVE_SEATS_UNAVAILABLE' }));
    const seats = await refusal(fetchLiveManifest(LIVE));
    apiFetch.mockResolvedValueOnce(json(429, { code: 'LIVE_START_RATE', limit: 6 }));
    const rate = await refusal(startLive(KEY));
    apiFetch.mockResolvedValueOnce(json(429, { statusCode: 429 }));
    const edge429 = await refusal(putLiveSegment(LIVE, 0, new Uint8Array([1])));

    expect(seats.kind).toBe('seats-unavailable');
    expect(seats.viewerCap).toBeNull();
    expect(isLiveRefusal(seats, 'full')).toBe(false);
    expect(rate.kind).toBe('rate-limited');
    expect(rate.code).toBe('LIVE_START_RATE');
    expect(edge429.kind).toBe('rate-limited');
    expect(edge429.code).toBeNull();
  });

  it.each([
    [404, { code: 'LIVE_NOT_FOUND' }, 'not-found'],
    [410, { code: 'LIVE_ENDED', endedAt: '2026-10-19T10:00:00.000Z' }, 'ended'],
    [403, { code: 'LIVE_VIEWER_REMOVED' }, 'removed'],
    [404, { message: 'Not Found', statusCode: 404 }, 'disabled'],
    [400, { code: 'LIVE_KEY_INVALID' }, 'refused'],
    [403, { code: 'LIVE_MUTED' }, 'refused'],
    [403, { code: 'LIVE_BROADCAST_SUSPENDED' }, 'suspended'],
    [403, { code: 'LIVE_BROADCAST_WITHDRAWN' }, 'withdrawn'],
    [409, { code: 'LIVE_ALREADY_OPEN' }, 'refused'],
    [502, { statusCode: 502 }, 'unavailable'],
  ] as const)('%i %j on the key read is %s', async (status, body, kind) => {
    apiFetch.mockResolvedValue(json(status, body));
    const e = await refusal(fetchLive(LIVE));
    expect(e.kind).toBe(kind);
    if (kind === 'ended') expect(e.endedAt).toBe('2026-10-19T10:00:00.000Z');
  });

  it('a 410 carries its endReason, and only `cut` is a moderation cut', async () => {
    apiFetch.mockResolvedValueOnce(
      json(410, { code: 'LIVE_ENDED', endedAt: '2026-10-19T10:00:00.000Z', endReason: 'cut' })
    );
    const cut = await refusal(fetchLive(LIVE));
    expect(cut.kind).toBe('ended');
    expect(cut.endReason).toBe('cut');
    expect(isLiveCut(cut)).toBe(true);

    apiFetch.mockResolvedValueOnce(json(410, { code: 'LIVE_ENDED', endReason: 'dropped' }));
    const hour = await refusal(fetchLive(LIVE));
    expect(hour.endReason).toBe('dropped');
    expect(isLiveCut(hour)).toBe(false);
  });

  it('an endReason this build does not know, or none, is null - never a guess', async () => {
    apiFetch.mockResolvedValueOnce(json(410, { code: 'LIVE_ENDED', endReason: 'something_new' }));
    expect((await refusal(fetchLive(LIVE))).endReason).toBeNull();
    apiFetch.mockResolvedValueOnce(json(410, { code: 'LIVE_ENDED' }));
    expect((await refusal(fetchLive(LIVE))).endReason).toBeNull();
    expect(isLiveCut(new Error('cut'))).toBe(false);
  });

  it.each([
    [409, 'LIVE_SEGMENT_OUT_OF_ORDER', 'out-of-order'],
    [409, 'LIVE_SEGMENT_IN_PROGRESS', 'retry-segment'],
    [409, 'LIVE_SEGMENT_RESERVATION_LOST', 'retry-segment'],
    [503, 'LIVE_STORE_UNAVAILABLE', 'retry-segment'],
    [503, 'LIVE_INGEST_BUSY', 'retry-segment'],
    [409, 'LIVE_SEGMENT_CONFLICT', 'refused'],
    [413, 'LIVE_BUDGET_EXHAUSTED', 'refused'],
    [429, 'LIVE_SEGMENT_TOO_FAST', 'rate-limited'],
    [400, 'LIVE_SEGMENT_EMPTY', 'refused'],
    [410, 'LIVE_ENDED', 'ended'],
  ] as const)('ingest %i %s is %s, with nextIndex', async (status, code, kind) => {
    apiFetch.mockResolvedValue(json(status, { code, nextIndex: 7 }));
    const e = await refusal(putLiveSegment(LIVE, 9, new Uint8Array([1])));
    expect(e.kind).toBe(kind);
    expect(e.code).toBe(code);
    expect(e.nextIndex).toBe(7);
  });

  it('the key at rest: an unopenable key and an unsealable start are retryable, never refused', async () => {
    expect(classifyLiveRefusal(503, 'LIVE_KEY_UNAVAILABLE', 'gateway')).toBe('unavailable');
    expect(classifyLiveRefusal(503, 'LIVE_KEY_SEALING_UNAVAILABLE', 'gateway')).toBe('unavailable');
    apiFetch.mockResolvedValue(json(503, { code: 'LIVE_KEY_UNAVAILABLE' }));
    const e = await refusal(fetchLive(LIVE));
    expect(e.kind).toBe('unavailable');
    expect(e.code).toBe('LIVE_KEY_UNAVAILABLE');
  });

  it('an edge page is not a gateway verdict: 4xx refused (never retried), 5xx unavailable', async () => {
    expect(classifyLiveRefusal(403, null, 'edge')).toBe('refused');
    expect(classifyLiveRefusal(413, null, 'edge')).toBe('refused');
    expect(classifyLiveRefusal(404, null, 'edge')).toBe('refused');
    expect(classifyLiveRefusal(502, null, 'edge')).toBe('unavailable');
    apiFetch.mockResolvedValue(html(504));
    expect((await refusal(fetchLive(LIVE))).kind).toBe('unavailable');
  });

  it('the segment fetch: a bare 404 is an absent segment, a 429 the per-address bound', async () => {
    trackedFetch.mockResolvedValueOnce(json(404, { statusCode: 404 }));
    expect((await refusal(fetchLiveSegment(LIVE, 'n'))).kind).toBe('not-found');
    trackedFetch.mockResolvedValueOnce(json(429, { statusCode: 429 }));
    expect((await refusal(fetchLiveSegment(LIVE, 'n'))).kind).toBe('rate-limited');
  });

  it('a transport failure is not a refusal and is never wrapped', async () => {
    const failure = new TransportFailureError(new TypeError('Failed to fetch'));
    apiFetch.mockRejectedValue(failure);
    await expect(fetchLiveManifest(LIVE)).rejects.toBe(failure);
  });
});

describe('LiveSegmentUploader', () => {
  const ok = (index: number) => json(200, { index, name: `n${index}`, nextIndex: index + 1 });
  const sent = () => apiFetch.mock.calls.map((c) => Number(String(c[0]).split('/').pop()));

  it('sends one at a time, in index order, from startIndex', async () => {
    apiFetch.mockImplementation(async (url: string) => ok(Number(url.split('/').pop())));
    const stored: number[] = [];
    const up = new LiveSegmentUploader(LIVE, {
      startIndex: 5,
      onStored: (r) => stored.push(r.index),
    });
    expect(up.nextIndex).toBe(5);
    up.enqueue(5, new Uint8Array([1]));
    up.enqueue(6, new Uint8Array([2]));
    up.enqueue(up.nextIndex, new Uint8Array([3]));
    expect(up.nextIndex).toBe(8);
    await up.idle();
    expect(sent()).toEqual([5, 6, 7]);
    expect(stored).toEqual([5, 6, 7]);
    expect(up.backlog).toBe(0);
  });

  it('retries the SAME index on a transport failure, a retry code and a 429 - never skips', async () => {
    apiFetch
      .mockRejectedValueOnce(new TransportFailureError(new TypeError('Failed to fetch')))
      .mockResolvedValueOnce(json(409, { code: 'LIVE_SEGMENT_IN_PROGRESS', nextIndex: 0 }))
      .mockResolvedValueOnce(json(429, { statusCode: 429 }))
      .mockResolvedValueOnce(ok(0))
      .mockResolvedValueOnce(ok(1));
    const up = new LiveSegmentUploader(LIVE, { backoffMs: () => 0 });
    up.enqueue(0, new Uint8Array([1]));
    up.enqueue(1, new Uint8Array([2]));
    await up.idle();
    expect(sent()).toEqual([0, 0, 0, 0, 1]);
    // Every retry of index 0 carries the SAME sealed bytes - a re-seal would be a 409 conflict.
    const bodies = await Promise.all(
      apiFetch.mock.calls.map(async (c) => [
        ...new Uint8Array(await (c[1].body as Blob).arrayBuffer()),
      ])
    );
    expect(bodies).toEqual([[1], [1], [1], [1], [2]]);
  });

  it('refuses an index other than nextIndex, loudly, and queues nothing', () => {
    apiFetch.mockImplementation(async (url: string) => ok(Number(url.split('/').pop())));
    const up = new LiveSegmentUploader(LIVE, { startIndex: 3 });
    expect(() => up.enqueue(4, new Uint8Array([1]))).toThrow(RangeError);
    expect(() => up.enqueue(2, new Uint8Array([1]))).toThrow(RangeError);
    expect(up.nextIndex).toBe(3);
    expect(up.backlog).toBe(0);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('tells each retried failure to onRetry, with its index and attempt, and never a stored one', async () => {
    apiFetch
      .mockRejectedValueOnce(new TransportFailureError(new TypeError('Failed to fetch')))
      .mockResolvedValueOnce(json(503, { code: 'LIVE_STORE_UNAVAILABLE' }))
      .mockResolvedValueOnce(ok(0));
    const onRetry = vi.fn();
    const up = new LiveSegmentUploader(LIVE, { backoffMs: () => 0, onRetry });
    up.enqueue(0, new Uint8Array([1]));
    await up.idle();
    expect(onRetry.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [0, 1],
      [0, 2],
    ]);
    expect(isLiveRefusal(onRetry.mock.calls[1][2], 'retry-segment')).toBe(true);
  });

  it('stops on a verdict (the live ended) and hands it over', async () => {
    apiFetch.mockResolvedValue(json(410, { code: 'LIVE_ENDED' }));
    const onStopped = vi.fn();
    const up = new LiveSegmentUploader(LIVE, { onStopped, backoffMs: () => 0 });
    up.enqueue(0, new Uint8Array([1]));
    up.enqueue(1, new Uint8Array([2]));
    await up.idle();
    expect(sent()).toEqual([0]);
    expect(isLiveRefusal(onStopped.mock.calls[0][0], 'ended')).toBe(true);
    expect(() => up.enqueue(up.nextIndex, new Uint8Array([3]))).toThrow();
  });

  it('stop() during a backoff ends the queue without another send', async () => {
    apiFetch.mockResolvedValue(json(503, { code: 'LIVE_INGEST_BUSY' }));
    const up = new LiveSegmentUploader(LIVE, { backoffMs: () => 60_000 });
    up.enqueue(0, new Uint8Array([1]));
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    up.stop();
    await up.idle();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});

describe('the chat routes (WP-L6)', () => {
  const CLIENT = '33333333-3333-4333-8333-333333333333';

  it('the manifest asks the chat with its cursors, and nothing when not given one', () => {
    expect(manifestQuery()).toBe('');
    expect(manifestQuery(4)).toBe('?from=4');
    expect(manifestQuery(undefined, {})).toBe('?chat=1');
    expect(manifestQuery(4, { messagesAfter: 0, reactionsAfter: 12 })).toBe(
      '?from=4&chat=1&messagesAfter=0&reactionsAfter=12'
    );
  });

  it('a message POSTs its clientId and sealed bytes, a burst its counts, a hide nothing', async () => {
    apiFetch.mockResolvedValueOnce(json(201, { id: 'm1', seq: 1 }));
    await postLiveMessage(LIVE, CLIENT, 'c2VhbGVk');
    expect(apiFetch).toHaveBeenLastCalledWith(`https://social.test/api/lives/${LIVE}/messages`, {
      method: 'POST',
      body: JSON.stringify({ clientId: CLIENT, sealed: 'c2VhbGVk' }),
    });

    apiFetch.mockResolvedValueOnce(json(201, { burstId: CLIENT, seq: 3 }));
    await postLiveReactions(LIVE, CLIENT, { like: 2 });
    expect(apiFetch).toHaveBeenLastCalledWith(`https://social.test/api/lives/${LIVE}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ burstId: CLIENT, counts: { like: 2 } }),
    });

    apiFetch.mockResolvedValueOnce(json(200, { liveId: LIVE, messageId: 'm1', hidden: true }));
    await hideLiveMessage(LIVE, 'm1');
    expect(apiFetch).toHaveBeenLastCalledWith(
      `https://social.test/api/lives/${LIVE}/messages/m1/hide`,
      { method: 'POST' }
    );
  });

  it('a too fast message is rate-limited, a removed viewer removed - typed at the throw', async () => {
    apiFetch.mockResolvedValueOnce(json(429, { code: 'LIVE_MESSAGE_TOO_FAST', retryAfterMs: 900 }));
    const fast = await refusal(postLiveMessage(LIVE, CLIENT, 'x'));
    expect([fast.kind, fast.code]).toEqual(['rate-limited', 'LIVE_MESSAGE_TOO_FAST']);
    apiFetch.mockResolvedValueOnce(json(403, { code: 'LIVE_VIEWER_REMOVED' }));
    expect((await refusal(postLiveMessage(LIVE, CLIENT, 'x'))).kind).toBe('removed');
  });

  it('never logs the sealed bytes', async () => {
    apiFetch.mockResolvedValueOnce(json(201, { id: 'm1', seq: 1 }));
    await postLiveMessage(LIVE, CLIENT, 'U0VDUkVUU0VBTEVE');
    const logged = [console.debug, console.log, console.warn]
      .flatMap((f) => vi.mocked(f).mock.calls.flat())
      .join(' ');
    expect(logged).not.toContain('U0VDUkVUU0VBTEVE');
  });
});
