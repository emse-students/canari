import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiServiceOrigins, resolveServiceUrl } from './apiUrl';

const TAURI_MARKER = '__TAURI_INTERNALS__';

/** The origin a build baked in before that build served two hostnames - NOT this page's. */
const BAKED = 'https://canari-emse.fr';

/** What `coreUrl()` would hand a browserless caller if nothing were baked in. */
const DEV_FALLBACK = 'http://localhost:3012';

function pretendTauri(): void {
  (window as unknown as Record<string, unknown>)[TAURI_MARKER] = {};
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>)[TAURI_MARKER];
});

/**
 * The decision is tested directly rather than through `coreUrl()` and its four siblings because
 * **Vite inlines `import.meta.env.VITE_*` at transform time**: the baked value is frozen into the
 * bundle before any test runs, so no amount of `vi.stubEnv` or assignment to `import.meta.env`
 * makes a caller see a different one per case. Measured, not assumed - after `vi.stubEnv`,
 * `import.meta.env.VITE_CORE_URL` reads back `undefined`, and only setting it in the process
 * environment before vitest starts changes what a caller sees. A test built on stubbing would have
 * passed its browser cases for the wrong reason and blamed its Tauri cases on runtime detection.
 */
describe('resolveServiceUrl', () => {
  /**
   * The regression this file exists for: production served ONE build at two public hostnames.
   *
   * `canari-prod` answers on both `canari-emse.fr` and `canari.emse.fr`, while the build bakes a
   * single `BASE_URL` secret into every `VITE_*_URL` as an absolute address. Reading the env var
   * first meant a page served from one hostname addressed the OTHER for every API call - which
   * CSP's `connect-src 'self'` refuses by design, so login died on the OIDC callback with a bare
   * NetworkError and no server-side trace. Allowing the cross-origin call instead would have been
   * worse: the session cookie would have landed on the wrong origin.
   */
  it('ignores the baked origin in a real browser, whatever was baked', () => {
    expect(resolveServiceUrl(BAKED, DEV_FALLBACK)).toBe(window.location.origin);
  });

  it('uses the page origin in a real browser when nothing was baked', () => {
    expect(resolveServiceUrl(undefined, DEV_FALLBACK)).toBe(window.location.origin);
  });

  /**
   * Tauri is the one runtime that genuinely needs the baked absolute URL: the page comes from
   * `tauri://localhost` (iOS) or `http://tauri.localhost` (Android), served by the embedded asset
   * server, so its own origin reaches no proxy. A path resolved against it is looked up as an
   * ASSET, misses, and Tauri answers `index.html` with status 200 - `res.ok` is true and the body
   * is HTML, which is how this class of defect hides instead of throwing.
   */
  it('uses the baked origin under Tauri, whose own origin reaches no proxy', () => {
    pretendTauri();

    expect(resolveServiceUrl(BAKED, DEV_FALLBACK)).toBe(BAKED);
  });

  it('strips a trailing slash, so a caller concatenating a path does not double it', () => {
    pretendTauri();

    expect(resolveServiceUrl(`${BAKED}/`, DEV_FALLBACK)).toBe(BAKED);
  });

  /**
   * No window at all (SSR, a worker): the baked value when there is one, the dev fallback otherwise.
   * Asserted HERE, on the decision, because a caller's own test cannot vary the baked value - the
   * `mlsDeliveryHttp` test that tried passed on CI and failed on any workstation with a `.env`.
   */
  it('without a window, uses the baked value, else the dev fallback', () => {
    vi.stubGlobal('window', undefined);

    expect(resolveServiceUrl(BAKED, DEV_FALLBACK)).toBe(BAKED);
    expect(resolveServiceUrl('', DEV_FALLBACK)).toBe(DEV_FALLBACK);
  });

  it('treats a blank baked value as absent rather than as an origin', () => {
    pretendTauri();

    expect(resolveServiceUrl('   ', DEV_FALLBACK)).toBe(window.location.origin);
  });
});

describe('apiServiceOrigins', () => {
  it('lists each distinct service ORIGIN once, never a path or an empty base', () => {
    // In a browser every service resolves to the page's own origin, so five bases collapse to one.
    expect(apiServiceOrigins()).toEqual([window.location.origin]);
  });

  it('under Tauri, names each baked origin and drops a trailing slash and any path', () => {
    expect(
      apiServiceOrigins({
        tauri: true,
        baked: {
          core: 'https://canari.emse.fr/',
          social: 'https://social.example:8443/api',
          gateway: 'https://canari.emse.fr',
          delivery: 'https://canari.emse.fr',
          media: 'https://media.example',
        },
      })
    ).toEqual(['https://canari.emse.fr', 'https://social.example:8443', 'https://media.example']);
  });

  it('under Tauri, dedupes five services baked with one origin', () => {
    const one = 'https://canari.emse.fr';
    expect(
      apiServiceOrigins({
        tauri: true,
        baked: { core: one, social: one, gateway: one, delivery: one, media: one },
      })
    ).toEqual([one]);
  });

  it('under Tauri, an empty or blank base falls to the shell origin, never an invented API one', () => {
    const one = 'https://canari.emse.fr';
    const origins = apiServiceOrigins({
      tauri: true,
      baked: { core: one, social: '', gateway: '  ', delivery: one, media: one },
    });
    expect(origins).toEqual([one, window.location.origin]);
  });

  it('outside Tauri, ignores the baked values exactly as resolveServiceUrl does', () => {
    expect(apiServiceOrigins({ tauri: false, baked: { core: BAKED } })).toEqual([
      window.location.origin,
    ]);
  });
});
