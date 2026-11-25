#!/usr/bin/env bun
/**
 * DOES THE SSR BOOT GATE FAIL WHEN THE SERVER DOES?
 *
 * `.github/scripts/boot-frontend-ssr.mjs` starts the web build's `index.js` and asks it for each kind
 * of page; the real build needs the generated WASM and is booted by CI only (`checks.sh
 * frontend-build`). What can be driven here is the gate's own decisions, against stub servers: a
 * server answering the whole table passes; a page answering 500, an unsubstituted `/login` head, a
 * server that exits before it answers and a missing build each fail, and the early exit carries the
 * server's stderr.
 *
 * Usage: bun .github/scripts/tests/boot-frontend-ssr.test.mjs   (no network beyond loopback)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ROUTE_TABLE,
  SEO_PLACEHOLDER,
  SEO_SUBSTITUTED,
  bootProblems,
} from '../boot-frontend-ssr.mjs';

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => {
  console.log(`  FAIL ${m}`);
  failures += 1;
};
const check = (cond, m) => (cond ? ok(m) : bad(m));

const dir = mkdtempSync(join(tmpdir(), 'ssr-boot-test-'));

/**
 * A stub server answering the route table, with `override` changing one path's status or body.
 * @param {string} name
 * @param {{ path?: string, status?: number, login?: string, exitFirst?: boolean, neverListens?: boolean }} override
 */
function stub(name, override = {}) {
  const file = join(dir, `${name}.mjs`);
  const table = Object.fromEntries(ROUTE_TABLE);
  const login = override.login ?? `<head><meta ${SEO_SUBSTITUTED} /></head>`;
  writeFileSync(
    file,
    override.exitFirst
      ? `console.error('boom: the stub refuses to start'); process.exit(3);\n`
      : override.neverListens
        ? `setInterval(() => {}, 1000);\n`
        : `const table = ${JSON.stringify(table)};
const override = ${JSON.stringify(override)};
Bun.serve({
  port: Number(process.env.PORT),
  hostname: process.env.HOST,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const status = path === override.path ? override.status : (table[path] ?? 404);
    return new Response(path === '/login' ? ${JSON.stringify(login)} : 'ok', { status });
  },
});
`
  );
  return file;
}

try {
  check(
    (await bootProblems({ entry: stub('whole') })).length === 0,
    'a server answering the whole table passes'
  );

  const p500 = await bootProblems({ entry: stub('crash', { path: '/post/x', status: 500 }) });
  check(
    p500.some((p) => p.startsWith('/post/x answered 500')),
    `a page answering 500 fails, named (${p500[0] ?? 'no problem reported'})`
  );

  const unsub = await bootProblems({
    entry: stub('marker', { login: `<meta name="${SEO_PLACEHOLDER}" data-canari-seo />` }),
  });
  check(
    unsub.some((p) => p.includes('still carries the SEO marker')),
    'a /login head with its marker left in place fails'
  );

  const empty = await bootProblems({ entry: stub('nohead', { login: '<head></head>' }) });
  check(
    empty.some((p) => p.includes(`no ${SEO_SUBSTITUTED} block`)),
    'a /login head with no SEO block at all fails'
  );

  const early = await bootProblems({ entry: stub('early', { exitFirst: true }) });
  check(
    early.length === 1 &&
      early[0].includes('exited before it answered') &&
      early[0].includes('boom'),
    'a server that exits before answering fails, with its stderr'
  );

  const missing = await bootProblems({ entry: join(dir, 'absent', 'index.js') });
  check(
    missing.length === 1 && missing[0].includes('does not exist'),
    'a build with no index.js fails'
  );

  const hang = await bootProblems({ entry: stub('hang', { neverListens: true }), ceilingMs: 500 });
  check(
    hang.length === 1 && hang[0].includes('neither answered nor exited'),
    'a server that never listens is stopped at the ceiling and fails'
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nboot-frontend-ssr: every decision holds');
