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
