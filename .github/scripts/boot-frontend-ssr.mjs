#!/usr/bin/env bun
/**
 * BOOTS THE SERVER-RENDERED FRONTEND THE BUILD JUST MADE, AND ASKS IT FOR EACH KIND OF PAGE.
 *
 * WHY THIS EXISTS (audit of #2613, item 5; built 2026-11-25). CI built the web target and never
 * STARTED it: a build that compiles and a server that answers are two facts, and only the first was
 * gated. The SvelteKit 3 audit booted it by hand. This makes that boot the gate, in the job that
 * already built it (`checks.sh frontend-build`): start `build/index.js` on a free loopback port,
 * wait for its first answer or its exit, ask each path of {@link ROUTE_TABLE}, assert each status,
 * assert that `/login`'s head had its SEO marker substituted, and stop the server.
 *
 * NO BACKEND IS REACHABLE HERE, AND THAT IS PART OF WHAT IT PROVES. The pages whose head is enriched
 * from social-service (`/post/x`, `/profile/x`, `/associations/x`) find no host. `serverSeo.ts`
 * serves the generic head then, flagged degraded, and the page answers 200. A page that answers
 * 500 for that reason is a page that breaks whenever a backend is down, so it is NOT listed as an
 * exception here. Every row is expected to pass with no backend.
 *
 * THE RUNTIME IS THIS PROCESS'S OWN (`process.execPath`, bun: the repository's rule). Production runs
 * the same `build/` on node 24 (`Dockerfile.frontend-ssr`), so this proves the build boots and routes,
 * not which runtime it was tuned for.
 *
 * THE ONLY BOUND IS A CEILING ON A HANG. Nothing asserts how fast the server starts or answers: the
 * wait ends on the first answer or on the process's exit. {@link HANG_CEILING_MS} only stops a server
 * that does neither from holding the job until GitHub's timeout.
 *
 *   bun .github/scripts/boot-frontend-ssr.mjs <frontend-build-dir>
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

/** Each path the audit of #2613 booted by hand, with the status it must answer. */
export const ROUTE_TABLE = [
  ['/login', 200],
  ['/posts', 200],
  ['/', 200],
  ['/associations/x', 200],
  ['/post/x', 200],
  ['/profile/x', 200],
  ['/c/join/x', 200],
  ['/sitemap.xml', 200],
  ['/robots.txt', 200],
  ['/app-shell', 200],
  ['/_app/version.json', 200],
  ['/a-path-no-route-matches', 404],
];

/**
 * What `/login`'s head must carry once the server wrote it: the marker `hooks.server.ts`
 * (`SEO_MARKER`) replaces is gone, and the block that replaced it is there.
 */
export const SEO_PLACEHOLDER = 'canari-seo-placeholder';
export const SEO_SUBSTITUTED = 'data-canari-seo';

/** Stops a server that neither answers nor exits. A ceiling on a hang, never an assertion. */
export const HANG_CEILING_MS = 120_000;

/** A free loopback port, asked of the kernel (port 0) and released for the server to take. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Starts `entry` with `runtime` on a free port and answers once the server answers one request, or
 * throws once it exits (with its stderr) or the ceiling passes.
 *
 * @param {{ entry: string, runtime?: string, env?: Record<string, string>, ceilingMs?: number }} options
 * @returns {Promise<{ base: string, stop: () => Promise<void>, output: () => string }>}
 */
export async function startServer({
  entry,
  runtime = process.execPath,
  env = {},
  ceilingMs = HANG_CEILING_MS,
}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`[SSR_BOOT] starting ${entry} on ${base}`);
  const child = spawn(runtime, [entry], {
    env: { ...process.env, ...env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  /** @type {{ code: number | null, signal: string | null } | null} */
  let exited = null;
  const exit = new Promise((resolve) =>
    // 'close', not 'exit': it fires once stdout and stderr are drained, so the output of a server that
    // died at start is complete when it is reported.
    child.once('close', (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    })
  );
  const stop = async () => {
    if (exited) return;
    child.kill('SIGTERM');
    await exit;
  };

  const deadline = Date.now() + ceilingMs;
  for (;;) {
    if (exited) {
      throw new Error(
        `the server exited before it answered (code ${exited.code}, signal ${exited.signal}):\n${output}`
      );
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`the server neither answered nor exited within ${ceilingMs} ms:\n${output}`);
    }
    try {
      await fetch(`${base}/_app/version.json`, { redirect: 'manual' });
      return { base, stop, output: () => output };
    } catch {
      // Not listening yet: a refused connect is the only thing a server that is still starting can
      // say. Ask again on the next turn of the loop, or learn that it exited.
      await Promise.race([exit, new Promise((r) => setTimeout(r, 100))]);
    }
  }
}

/**
 * Asks every path of `table` of the server at `base`, and returns one sentence per violation.
 *
 * @param {string} base
 * @param {Array<[string, number]>} [table]
 * @returns {Promise<string[]>}
 */
export async function routeProblems(base, table = ROUTE_TABLE) {
  const problems = [];
  for (const [path, want] of table) {
    let res;
    try {
      res = await fetch(`${base}${path}`, { redirect: 'manual' });
    } catch (e) {
      problems.push(`${path}: no answer (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const body = await res.text();
    console.log(`[SSR_BOOT] ${path} -> ${res.status} (want ${want})`);
    if (res.status !== want) {
      problems.push(`${path} answered ${res.status}, not ${want}`);
      continue;
    }
    if (path === '/login') {
      if (body.includes(SEO_PLACEHOLDER)) {
        problems.push(
          `/login still carries the SEO marker (${SEO_PLACEHOLDER}): the head was not substituted`
        );
      } else if (!body.includes(SEO_SUBSTITUTED)) {
        problems.push(
          `/login carries no ${SEO_SUBSTITUTED} block: the head substitution wrote nothing`
        );
      }
    }
  }
  return problems;
}

/**
 * The whole gate: start, ask, stop. Returns the problems; the server's output is appended to them
 * when there is any, since it is what names the cause.
 *
 * @param {{ entry: string, runtime?: string, env?: Record<string, string>, table?: Array<[string, number]>, ceilingMs?: number }} options
 * @returns {Promise<string[]>}
 */
export async function bootProblems({ entry, runtime, env, table, ceilingMs }) {
  if (!existsSync(entry))
    return [`${entry} does not exist - the web build (BUILD_WEB=1) wrote no server`];
  let server;
  try {
    server = await startServer({ entry, runtime, env, ceilingMs });
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)];
  }
  try {
    const problems = await routeProblems(server.base, table);
    if (problems.length > 0) problems.push(`server output:\n${server.output()}`);
    return problems;
  } finally {
    await server.stop();
  }
}

if (import.meta.main) {
  const buildDir = process.argv[2];
  if (!buildDir) {
    console.error('usage: bun boot-frontend-ssr.mjs <frontend-build-dir>');
    process.exit(2);
  }
  const problems = await bootProblems({ entry: join(buildDir, 'index.js') });
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error::[SSR_BOOT] ${p}`);
    process.exit(1);
  }
  console.log(`[SSR_BOOT] every one of ${ROUTE_TABLE.length} paths answered as expected`);
}
