import type { HandleServerError } from '@sveltejs/kit';

/**
 * A 404 IS A CORRECT ANSWER; A 500 IS THIS APPLICATION FAILING. THEY MAY NOT SHARE A LEVEL.
 *
 * Without this hook SvelteKit installs its own default, which calls `format_server_error` and
 * prints EVERY status through `console.error` wrapped in a hardcoded `\x1b[1;31m` - so a scanner
 * probing `/.env` and a genuine server fault arrive on stderr in the same red, and only one of them
 * carries a stack. Nine such lines made a whole pass-2 server window read `NOT CLEAN` on
 * 2026-08-15; all nine were answered 404 and nothing was served. The cost is the standing one about
 * levels: a reader who learns that red SSR lines are scanners is the reader who will skim past the
 * 500.
 *
 * THE FIRST LINE KEEPS SVELTEKIT'S EXACT SHAPE - `[<status>] <METHOD> <path>` - on purpose. That
 * shape is what `srvlog.mjs` classifies the server window by, path by path, with a written
 * justification per rule; inventing a new wording here would silently un-classify every one of them
 * and turn a whole category of understood traffic back into `unexplained`. What changes is the
 * LEVEL, the colour, and the fact that a 5xx now carries its stack.
 *
 * It lives here rather than inside `hooks.server.ts` so it can be tested without dragging that
 * file's SEO imports - and `$env/dynamic/private` under them - into a unit test.
 */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
  const where = `[${status}] ${event.request.method} ${event.url.pathname}`;

  if (status < 500) {
    console.warn(where);
    return { message };
  }

  console.error(`${where}\n${error instanceof Error ? error.stack : String(error)}`);
  return { message };
};
