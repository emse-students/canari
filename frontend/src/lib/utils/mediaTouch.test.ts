/**
 * The rules that make the retention clock honest WITHOUT making it expensive.
 *
 * The defect this guards against is asymmetric, and the tests are written around that asymmetry:
 * over-reporting costs requests, under-reporting DELETES SOMEBODY'S PHOTOGRAPH. So a failed report
 * must always leave the media reportable again, never marked as done.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` because the module under test imports appendLog at its top level, so the mock
// factory runs before any plain `const` in this file would exist.
const { appendLogMock } = vi.hoisted(() => ({ appendLogMock: vi.fn() }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: appendLogMock,
}));
vi.mock('$lib/stores/auth', () => ({
  getToken: () => Promise.resolve('test-token'),
}));

import { noteMediaCacheHit, resetMediaTouchStateForTests } from './mediaTouch';

const BASE = 'https://delivery.example.com';
const fetchMock = vi.fn();

/** Runs the 2 s merge window to completion and lets the flush's awaits settle. */
async function runFlush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2_100);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
}

function bodyIdsOf(call: number): string[] {
  return JSON.parse(fetchMock.mock.calls[call][1].body).mediaIds;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  appendLogMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ refreshed: 1 }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  resetMediaTouchStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('noteMediaCacheHit', () => {
  it('reports a cache hit to the media service', async () => {
    noteMediaCacheHit('id-a', BASE);
    await runFlush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/media/touch`);
    expect(bodyIdsOf(0)).toEqual(['id-a']);
  });

  it('merges several hits into ONE request, so the cost is not per rendered image', async () => {
    noteMediaCacheHit('id-a', BASE);
    noteMediaCacheHit('id-b', BASE);
    noteMediaCacheHit('id-c', BASE);
    await runFlush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyIdsOf(0)).toEqual(['id-a', 'id-b', 'id-c']);
  });

  it('reports an id at most once per day even across a reload', async () => {
    noteMediaCacheHit('id-a', BASE);
    await runFlush();
    fetchMock.mockClear();

    // A reload keeps localStorage and loses every in-memory marker - which is exactly the case a
    // session-only dedup would get wrong.
    resetMediaTouchStateForTests();
    noteMediaCacheHit('id-a', BASE);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-reports on a LATER day, because the clock it feeds is a 30-day one', async () => {
    noteMediaCacheHit('id-a', BASE);
    await runFlush();
    fetchMock.mockClear();

    // Same device, next day: the marker is keyed by calendar day, so the record is replaced.
    localStorage.setItem(
      'canari-media-touched',
      JSON.stringify({ day: '1999-01-01', ids: ['id-a'] })
    );
    resetMediaTouchStateForTests();
    noteMediaCacheHit('id-a', BASE);
    await runFlush();

    expect(bodyIdsOf(0)).toEqual(['id-a']);
  });

  it('does NOT mark an id as reported when the server rejects it', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));
    noteMediaCacheHit('id-a', BASE);
    await runFlush();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ refreshed: 1 }), { status: 200 }));

    // The next view must try again: marking on enqueue would cost the object a day of clock for
    // one dropped request, and the failure mode here must never be "expires sooner".
    noteMediaCacheHit('id-a', BASE);
    await runFlush();

    expect(bodyIdsOf(0)).toEqual(['id-a']);
  });

  it('does NOT mark an id as reported when the request throws', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    noteMediaCacheHit('id-a', BASE);
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.waitFor(() => expect(appendLogMock).toHaveBeenCalled());

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ refreshed: 1 }), { status: 200 }));
    noteMediaCacheHit('id-a', BASE);
    await runFlush();

    expect(bodyIdsOf(0)).toEqual(['id-a']);
  });

  it('flushes immediately once the batch is full rather than holding 200 ids on a timer', async () => {
    for (let i = 0; i < 200; i++) noteMediaCacheHit(`id-${i}`, BASE);

    // No timer has been advanced at all here: the size cap is what fired.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyIdsOf(0)).toHaveLength(200);
  });

  it('groups by base URL, since an id only means something to the service that stores it', async () => {
    const other = 'https://other.example.com';
    noteMediaCacheHit('id-a', BASE);
    noteMediaCacheHit('id-b', other);
    await runFlush();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain(`${BASE}/api/media/touch`);
    expect(urls).toContain(`${other}/api/media/touch`);
  });
});
