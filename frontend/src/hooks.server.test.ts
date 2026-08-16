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
import { SITE } from '$lib/seo/site';

// Read from the project root rather than from `import.meta.url`: under Vitest's transform that URL
// is not a `file:` one, and `app.html` is not a module anyway - it is the artefact being asserted.
const appHtml = readFileSync('src/app.html', 'utf8');

/** Only the four fields `handleError` reads, shaped as SvelteKit passes them. */
const evt = (method: string, pathname: string) =>
  ({ request: { method }, url: { pathname } }) as never;

describe('app.html carries the markers hooks.server.ts substitutes', () => {
  it('has the SEO comment marker', () => {
    expect(appHtml).toContain('<!--canari-seo-->');
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
      error: new Error('Not found'),
      event: evt('GET', '/.env'),
      status: 404,
      message: 'Not Found',
    } as never);

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[404] GET /.env');
    expect(result).toEqual({ message: 'Not Found' });
  });

  it('logs a 500 at error, WITH its stack', () => {
    const boom = new Error('boom');
    boom.stack = 'Error: boom\n    at somewhere';

    handleError({
      error: boom,
      event: evt('POST', '/chat'),
      status: 500,
      message: 'Internal Error',
    } as never);

    expect(warn).not.toHaveBeenCalled();
    const printed = String(error.mock.calls[0][0]);
    // The first line keeps SvelteKit's own shape, because srvlog.mjs classifies on it.
    expect(printed.split('\n')[0]).toBe('[500] POST /chat');
    expect(printed).toContain('at somewhere');
  });

  it('never colours a line itself - the level and the stack are what sort them', () => {
    handleError({
      error: new Error('x'),
      event: evt('GET', '/nope'),
      status: 404,
      message: 'Not Found',
    } as never);

    expect(String(warn.mock.calls[0][0])).not.toContain('[');
  });
});
