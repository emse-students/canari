#!/usr/bin/env bun
/**
 * Asserts that the BUILT pages carry the Content-Security-Policy the source describes, and that the
 * policy allows every inline script they hold - and nothing inline beyond them.
 *
 * WHY ON THE OUTPUT. `csp.test.ts` proves the description; only the build shows what SvelteKit did
 * with it. A script whose hash is missing is refused by the browser before first paint, without a
 * word in any gate here - the page is blank, or the theme flashes, or the WASM preload never
 * starts. So every inline classic script of a built page is hashed HERE and looked up in the page's
 * own policy.
 *
 * TWO FORMS, decided by the same variable as `kit.config.js`:
 *  - WEB (`BUILD_WEB`): `build/prerendered/app-shell.html` - the shell nginx serves when the SSR
 *    server is down, rendered from the same template as every server-rendered page - must carry the
 *    `<meta http-equiv="content-security-policy">` SvelteKit writes, with no `'unsafe-inline'` or
 *    `'unsafe-eval'` for scripts, with `'wasm-unsafe-eval'`, and with the hash of each inline script.
 *  - NATIVE: `build/index.html` must carry NO policy of SvelteKit's: Tauri states its own
 *    (`src-tauri/tauri.conf.json`) and hashes the embedded scripts itself; a second one here would
 *    only be intersected with it.
 *
 * Exits non-zero with what it found.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlineScriptHashes } from '../src/lib/security/cspPolicy.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILD = join(ROOT, 'build');
const web = !!process.env.BUILD_WEB;

/** @param {string} message */
function fail(message) {
  console.error(`[csp] ${message}`);
  process.exit(1);
}

/**
 * The policy of the `<meta http-equiv="content-security-policy">` elements of a page.
 *
 * @param {string} html the page.
 * @returns {string[]} each policy, HTML-unescaped.
 */
function metaPolicies(html) {
  return [...html.matchAll(/<meta http-equiv="content-security-policy" content="([^"]*)"/gi)].map(
    (m) => m[1].replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&')
  );
}

const page = web ? join(BUILD, 'prerendered', 'app-shell.html') : join(BUILD, 'index.html');
if (!existsSync(page)) fail(`${page} is missing - run the ${web ? 'web' : 'native'} build first`);
const html = readFileSync(page, 'utf8');
const policies = metaPolicies(html);

if (!web) {
  if (policies.length > 0) {
    fail(
      `the native page carries a policy of SvelteKit's, which Tauri's would be intersected with: ${policies[0]}`
    );
  }
  console.log('[csp] native build: no SvelteKit policy - tauri.conf.json states the WebView one');
  process.exit(0);
}

if (policies.length !== 1) fail(`app-shell.html carries ${policies.length} policies, expected 1`);
const policy = policies[0];
const scriptDirective = policy
  .split(';')
  .map((d) => d.trim().split(/\s+/))
  .find((d) => d[0] === 'script-src');
if (!scriptDirective) fail(`the policy has no script-src: ${policy}`);
const scriptSrc = scriptDirective.slice(1);

for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'"]) {
  if (scriptSrc.includes(forbidden)) fail(`script-src allows ${forbidden}: ${policy}`);
}
if (!scriptSrc.includes("'wasm-unsafe-eval'")) {
  fail(`script-src lacks 'wasm-unsafe-eval' - the MLS engine could not compile: ${policy}`);
}

const hashes = inlineScriptHashes(html);
if (hashes.length === 0)
  fail('app-shell.html holds no inline script - the check reads the wrong file');
const missing = hashes.filter((h) => !scriptSrc.includes(`'${h}'`));
if (missing.length > 0) {
  fail(
    `${missing.length} inline script(s) of app-shell.html are not in its policy, so a browser refuses them: ${missing.join(' ')}`
  );
}

console.log(
  `[csp] web build: app-shell.html's ${hashes.length} inline scripts are each allowed by hash; no 'unsafe-inline' or 'unsafe-eval' for scripts`
);
