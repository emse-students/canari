/**
 * A TEST THAT REACHES FOR THE REAL NETWORK FAILS, INSTEAD OF PRINTING `ECONNREFUSED` AND PASSING.
 *
 * happy-dom's `fetch` opens a real socket. A component or store mounted without its HTTP seam mocked
 * therefore dialled `localhost:3000` (the API base URL default), was refused, swallowed the refusal
 * and went green - leaving ~130 stack traces per full run (found 2026-10-15, nine test files: a
 * name lookup, an avatar read, a token refresh, a notification-level read). Noise nobody can tell
 * from a real defect hides the next real defect, and no test was ever about that traffic.
 *
 * THE DESIGN. The default `fetch` is replaced by a function that never connects: it records the
 * attempt and rejects. An `afterEach` then FAILS the test that made the attempt, naming the URL, so
 * the fix is where it belongs - mock the module issuing the request, as the neighbouring tests do.
 * Only `http(s)` is intercepted (a `data:` or `blob:` URL opens no socket). A test that installs its
 * own `fetch` (`vi.stubGlobal`, `vi.spyOn`, `globalThis.fetch =`) replaces this one and is untouched.
 * An attempt that lands after its test has ended is rejected too, only it has no test left to fail.
 */
import { afterEach } from 'vitest';

const attempts: string[] = [];

const realFetch = globalThis.fetch;

globalThis.fetch = function guardedFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  let absolute: URL | null = null;
  try {
    absolute = new URL(url, globalThis.location?.href);
  } catch {
    // Not a parseable URL: the real fetch rejects it itself, without a socket.
  }
  if (absolute && (absolute.protocol === 'http:' || absolute.protocol === 'https:')) {
    attempts.push(`${init?.method ?? 'GET'} ${absolute.href}`);
    return Promise.reject(
      new TypeError(`fetch blocked in tests: ${absolute.href} - mock the module that issues it`)
    );
  }
  return realFetch.call(globalThis, input, init);
} as typeof fetch;

afterEach(() => {
  if (attempts.length === 0) return;
  const made = attempts.splice(0);
  throw new Error(
    `This test attempted a real network request (${made.join(', ')}). Mock the module that ` +
      'issues it, the way neighbouring tests do - the request was blocked, not sent.'
  );
});
