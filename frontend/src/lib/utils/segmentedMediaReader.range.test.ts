/**
 * A ranged read fails in the SAME vocabulary as a whole download (`mediaFailureCause`), so a
 * streamed post shows the same cause and the same "Reessayer" as every other media.
 */
import { vi } from 'vitest';
import { mediaFailureCause } from './mediaErrors';

vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));

const { httpRangeSource } = await import('./segmentedMediaReader');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function causeOf(fetchImpl: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const err = await httpRangeSource('https://media.test', 'm1')
    .read(0, 10)
    .catch((e) => e);
  return mediaFailureCause(err);
}

/**
 * THE LINK IS MEASURED FROM THE SLOT, NOT FROM THE QUEUE (slow-link chantier, gap 6): a range that
 * waited five seconds behind three other media and then took one second to arrive reads as one
 * second of link, or a busy feed would call a fast link slow.
 */
it('measures a read from the moment the gate grants its slot to its last byte', async () => {
  const { mediaRequestGate } = await import('./requestGate');
  let now = 0;
  const releases: Array<() => void> = [];
  const busy = Array.from({ length: 3 }, () =>
    mediaRequestGate.run(() => new Promise<void>((resolve) => releases.push(resolve)))
  );
  let answer: (r: Response) => void = () => {};
  const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
  vi.stubGlobal('fetch', fetchMock);
  const observe = vi.fn();
  const read = httpRangeSource('https://media.test', 'm1', observe, () => now).read(0, 100_000);

  now = 5_000; // queued behind the three
  releases[0]();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  now = 6_000; // one second on the wire
  answer(new Response(new Uint8Array(100_000), { status: 206 }));
  await read;

  expect(observe).toHaveBeenCalledWith(100_000, 1);
  for (const release of releases.slice(1)) release();
  await Promise.all(busy);
});

it('types each failure of a range read as the whole download does', async () => {
  expect(await causeOf(() => Promise.reject(new TypeError('Failed to fetch')))).toBe('unreachable');
  expect(await causeOf(() => Promise.resolve(new Response(null, { status: 404 })))).toBe(
    'not-found'
  );
  expect(await causeOf(() => Promise.resolve(new Response(null, { status: 410 })))).toBe('expired');
  expect(await causeOf(() => Promise.resolve(new Response(null, { status: 503 })))).toBe('other');
});

it('reads a 416 as "no bytes", which the reader turns into a truncation', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(null, { status: 416 })))
  );
  const bytes = await httpRangeSource('https://media.test', 'm1').read(100, 200);
  expect(bytes.byteLength).toBe(0);
});
