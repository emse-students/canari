/**
 * THE POST-DEPLOY WASM CHECK MUST REFUSE WHAT IT IS MEANT TO REFUSE, AND ONLY THAT.
 *
 * `deployed-wasm-check.mjs` is a GATE since 2026-10-06: `serve-dev.yml` runs it before it records
 * `dev-deployed`, and the release preflight refuses a stable whose pre-release never served dev. A
 * gate that exits 0 for a panicking wasm, or 1 for a clean one, is worse than none - so this drives
 * the real script, as a child process, against a local stand-in estate that serves a landing page, a
 * chunk and a wasm, and asserts the three exit codes the workflow relies on:
 *
 *   0 clean   1 the served wasm carries std's unsupported-platform panic   2 could not look
 *
 * IT ALSO PINS THE CACHE-BUSTING QUERY: the landing page must be asked for under a query of its own,
 * or a freshly deployed estate could answer the previous build's cached shell.
 *
 * Pure: a loopback server and a child process, no estate, no `names.mjs` (the script must run
 * without one - it is run on a fresh checkout), so it belongs in `make test-harness`.
 *
 *   bun archive/deployed-wasm-selftest.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = join(dirname(dirname(fileURLToPath(import.meta.url))), 'deployed-wasm-check.mjs');
const MARKER = 'not implemented on this platform';

let failures = 0;
const ok = (what, cond) => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`);
};

/**
 * Serves a landing page -> a relative chunk -> the wasm, the way the real shell chains them.
 *
 * @param {{ wasm: Buffer | null, landingQueries: string[] }} estate what `/wasm` answers, and a sink
 * for the query string each landing request carried
 */
function serve(estate) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/') {
        estate.landingQueries.push(url.search);
        return new Response('<script src="/_app/immutable/chunks/AAA.js"></script>', {
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url.pathname === '/_app/immutable/chunks/AAA.js') {
        const body = estate.wasm
          ? 'import w from "/_app/immutable/assets/mls_wasm_bg.HASH123.wasm";'
          : 'export default 1;';
        return new Response(body, { headers: { 'content-type': 'text/javascript' } });
      }
      if (url.pathname === '/_app/immutable/assets/mls_wasm_bg.HASH123.wasm' && estate.wasm) {
        return new Response(estate.wasm);
      }
      return new Response('nope', { status: 404 });
    },
  });
}

/** Runs the real script against `origin`, with the rig's `names.mjs` deliberately not consulted. */
async function run(origin) {
  const child = Bun.spawn([process.execPath, CHECK, origin], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, out: out + err };
}

const cases = [
  {
    name: 'a clean wasm',
    wasm: Buffer.from('\0asm-clean-bytes'),
    code: 0,
    says: /ok - /,
  },
  {
    name: 'a wasm carrying the unsupported-platform panic',
    wasm: Buffer.from(`\0asm....time ${MARKER}....`, 'latin1'),
    code: 1,
    says: /REFUSED/,
  },
  {
    name: 'an estate whose chunks never name the wasm (the check could not look - NOT a pass)',
    wasm: null,
    code: 2,
    says: /could not find the wasm reference/,
  },
];

for (const c of cases) {
  const estate = { wasm: c.wasm, landingQueries: [] };
  const server = serve(estate);
  try {
    const { code, out } = await run(`http://127.0.0.1:${server.port}`);
    ok(`${c.name} exits ${c.code} (got ${code})`, code === c.code);
    ok(`${c.name} says so`, c.says.test(out));
    ok(
      `${c.name}: the landing page was asked for under its own query`,
      estate.landingQueries.length > 0 &&
        estate.landingQueries.every((q) => q.startsWith('?deployed-wasm-check='))
    );
  } finally {
    server.stop(true);
  }
}

console.log(
  failures
    ? `[deployed-wasm] ${failures} FAILURE(S) - the dev gate would pass or refuse the wrong build`
    : '[deployed-wasm] clean - the post-deploy wasm gate refuses what it should and passes what it should'
);
process.exit(failures ? 1 : 0);
