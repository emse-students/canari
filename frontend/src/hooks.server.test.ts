/**
 * The two things about `hooks.server.ts` that fail SILENTLY.
 *
 * **The markers.** The SSR head is written by substituting two literal strings into `app.html`.
 * `String.replace` on a string that is not there returns the original unchanged, so renaming either
 * marker turns the whole hook into a no-op that still runs, still logs nothing, and still serves a
 * page - only with the generic head every Canari link had before this existed. Its own doc comment
 * has been promising that a test pins them; it did not exist until now.
 *
 * **The levels.** A 404 is a correct answer about a route this application does not have, a 500 is
 * this application failing, and SvelteKit's default handler prints both through `console.error` in
 * the same hardcoded red. The first line's SHAPE is load-bearing beyond the reader: `srvlog.mjs`
 * classifies the server window by it, path by path.
 */
import { readFileSync } from 'node:fs';
import { handleError } from '$lib/server/handleError';
import { preloadableAsset } from '$lib/server/preload';
import { WASM_PRELOAD_MARKER, renderWasmPreloadMeta } from '$lib/server/wasmPreload';
import { MLS_DEVICE_ID_PREFIX } from '$lib/mls-client/wasmPrefetch';
import { SITE } from '$lib/seo/site';
import { inlineScripts } from '$lib/security/cspPolicy.js';

// Read from the project root rather than from `import.meta.url`: under Vitest's transform that URL
// is not a `file:` one, and `app.html` is not a module anyway - it is the artefact being asserted.
const appHtml = readFileSync('src/app.html', 'utf8');

/** Only the four fields `handleError` reads, shaped as SvelteKit passes them. */
const evt = (method: string, pathname: string) =>
  ({ request: { method }, url: { pathname } }) as never;

describe('app.html carries the markers hooks.server.ts substitutes', () => {
  it('has the SEO marker, and it is not a comment', () => {
    expect(appHtml).toContain('<meta name="canari-seo-placeholder" data-canari-seo />');
    // A comment marker made SvelteKit warn about hydration on every dev start, because a
    // transform that drops a comment cannot be told apart from one dropping a hydration anchor.
    // Asserting its ABSENCE is what stops the cheaper form coming back.
    expect(appHtml).not.toContain('<!--canari-seo-->');
  });

  it('has the exact static title the hook REPLACES, spelt as SITE.defaultTitle', () => {
    // Replaced rather than added to: two titles in a document means the first one wins, and the
    // static one is the first. So the string has to match to the character, accent included.
    expect(appHtml).toContain(`<title>${SITE.defaultTitle}</title>`);
  });
});

describe('handleError separates a correct answer from a failure', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a 404 at warn, with no stack and no colour', () => {
    const result = handleError({
      kind: 'framework',
      error: { status: 404, message: 'Not Found' },
      event: evt('GET', '/.env'),
    } as never);

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[404] GET /.env');
    // Nothing is returned: SvelteKit's own status and safe message stand.
    expect(result).toBeUndefined();
  });

  it('logs a 500 at error, WITH its stack', () => {
    const boom = new Error('boom');
    boom.stack = 'Error: boom\n    at somewhere';

    handleError({ kind: 'unknown', error: boom, event: evt('POST', '/chat') } as never);

    expect(warn).not.toHaveBeenCalled();
    const printed = String(error.mock.calls[0][0]);
    // The first line keeps SvelteKit's own shape, because srvlog.mjs classifies on it.
    expect(printed.split('\n')[0]).toBe('[500] POST /chat');
    expect(printed).toContain('at somewhere');
  });

  it('never colours a line itself - the level and the stack are what sort them', () => {
    handleError({
      kind: 'framework',
      error: { status: 404, message: 'Not Found' },
      event: evt('GET', '/nope'),
    } as never);

    expect(String(warn.mock.calls[0][0])).not.toContain('\x1b[');
  });
});

describe('a stylesheet the document already declares earns no preload header', () => {
  /**
   * SvelteKit emits the `<link rel="stylesheet">` and the `Link: rel=preload; as=style` header from
   * the SAME response, so the hint arrives with the tag it hints at. Chrome records one fetch per
   * sheet, initiated by the tag; the user's Firefox reports every one of them as an unused preload.
   */
  it('refuses css', () => {
    expect(preloadableAsset({ type: 'css', path: '/_app/immutable/assets/0.heJSv4Af.css' })).toBe(
      false
    );
  });

  /**
   * The one type that MUST keep its header. `rel="modulepreload"` is what lets the whole chunk graph
   * be discovered at once rather than a level at a time.
   */
  it('keeps js', () => {
    expect(preloadableAsset({ type: 'js', path: '/_app/immutable/chunks/x.js' })).toBe(true);
  });

  /**
   * PINS THE NARROWING, NOT JUST THE EXCLUSION. SvelteKit's default is `js || css`, so fonts and
   * assets never carried a header here; writing this predicate as `!== 'css'` would have started
   * preloading both. These two cases are what make that a test failure rather than a surprise.
   */
  it('does not START preloading anything the default left alone', () => {
    expect(preloadableAsset({ type: 'font', path: '/_app/immutable/assets/x.woff2' })).toBe(false);
    expect(preloadableAsset({ type: 'asset', path: '/_app/immutable/assets/x.png' })).toBe(false);
  });
});

describe('the WASM preload (wasmPreload.ts) starts the download beside the JS', () => {
  const URL_HASHED = '/_app/immutable/assets/mls_wasm_bg.AbCd1234.wasm';

  /** The one inline script of app.html that reads the marker: fixed text, so the CSP hashes it. */
  function preloadScript(): string {
    const scripts = inlineScripts(appHtml);
    const found = scripts.filter((s) => s.includes('canari-wasm-preload'));
    expect(found).toHaveLength(1);
    return found[0];
  }

  /** The attributes of the `<meta>` the hook writes, read back the way a browser parses them. */
  function metaAttributes(meta: string | null): Record<string, string> {
    if (meta === null) return {};
    const attributes: Record<string, string> = {};
    for (const m of meta.matchAll(/([a-z-]+)="([^"]*)"/g)) {
      attributes[m[1]] = m[2]
        .replaceAll('&quot;', '"')
        .replaceAll('&lt;', '<')
        .replaceAll('&amp;', '&');
    }
    return attributes;
  }

  /**
   * Runs app.html's preload script against a fake browser whose marker is `meta` (null: the
   * marker left unfilled, as in the native shell) and returns the links it appended.
   */
  function run(opts: {
    keys: string[];
    tauri?: boolean;
    throwsOnStorage?: boolean;
    meta?: string | null;
  }) {
    const appended: Record<string, unknown>[] = [];
    const attributes = metaAttributes(
      opts.meta === undefined ? renderWasmPreloadMeta(URL_HASHED) : opts.meta
    );
    const win: Record<string, unknown> = opts.tauri ? { __TAURI_INTERNALS__: {} } : {};
    const storage = opts.throwsOnStorage
      ? new Proxy(
          {},
          {
            get: () => {
              throw new Error('blocked');
            },
          }
        )
      : { length: opts.keys.length, key: (i: number) => opts.keys[i] ?? null };
    const doc = {
      querySelector: (selector: string) =>
        selector === 'meta[name="canari-wasm-preload"]'
          ? { getAttribute: (name: string) => attributes[name] ?? null }
          : null,
      createElement: () => ({}) as Record<string, unknown>,
      head: { appendChild: (l: Record<string, unknown>) => appended.push(l) },
    };
    new Function('window', 'localStorage', 'document', preloadScript())(win, storage, doc);
    return appended;
  }

  it('is substituted for a marker app.html really carries', () => {
    expect(appHtml).toContain(WASM_PRELOAD_MARKER);
    // A node, never a comment: the SEO marker's reason (hydration warning on a dropped comment).
    expect(WASM_PRELOAD_MARKER.startsWith('<!--')).toBe(false);
    // The filled marker is still the element the script selects.
    expect(renderWasmPreloadMeta(URL_HASHED)).toMatch(/^<meta name="canari-wasm-preload" /);
  });

  it('appends a preload link for the hashed URL when a device was enrolled', () => {
    const links = run({ keys: ['theme', `${MLS_DEVICE_ID_PREFIX}u1`] });
    expect(links).toHaveLength(1);
    // as=fetch + anonymous CORS is the request the loader's fetch(url, {credentials:'same-origin'})
    // makes; any other pair downloads the 2 MB twice.
    expect(links[0]).toMatchObject({
      rel: 'preload',
      as: 'fetch',
      crossOrigin: 'anonymous',
      href: URL_HASHED,
    });
  });

  it('adds nothing for an anonymous profile, under Tauri, when storage is refused, or unfilled', () => {
    expect(run({ keys: ['theme', 'other'] })).toHaveLength(0);
    expect(run({ keys: [`${MLS_DEVICE_ID_PREFIX}u1`], tauri: true })).toHaveLength(0);
    expect(run({ keys: [], throwsOnStorage: true })).toHaveLength(0);
    // The native shell: nothing fills the marker, so there is no URL to preload.
    expect(run({ keys: [`${MLS_DEVICE_ID_PREFIX}u1`], meta: WASM_PRELOAD_MARKER })).toHaveLength(0);
  });

  it('uses the prefix the in-bundle prefetch uses: one predicate, two places', () => {
    expect(metaAttributes(renderWasmPreloadMeta(URL_HASHED))['data-device-prefix']).toBe(
      MLS_DEVICE_ID_PREFIX
    );
  });

  it('carries no build-specific text in the script, so its CSP hash holds across builds', () => {
    // The URL changes with every build of the binary; the script must not, or its hash would not
    // be the one the policy was given (lib/security/cspPolicy.js).
    expect(preloadScript()).not.toContain('mls_wasm_bg');
    expect(preloadScript()).not.toContain(MLS_DEVICE_ID_PREFIX);
  });
});
