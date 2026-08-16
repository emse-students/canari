#!/usr/bin/env node
/**
 * ONE APP TAB PER BROWSER. Reports what is open, and closes every extra.
 *
 * The mechanism and the run it cost are on `closeExtraAppTabs` in `tabs.mjs` and in rule 5 of
 * `docs/wiki/testing-methodology.md`; this file is only its command line. The preflight in `run.mjs`
 * calls the same function before every job, so this is for a browser touched by hand.
 *
 * Usage: node onetab.mjs [--device W1|W2] [--dry]
 *   --dry  report only, and exit non-zero if any browser is ambiguous
 */
import { listTargets } from './cdp.mjs';
import { closeExtraAppTabs } from './tabs.mjs';
import { PORTS, SITE } from './names.mjs';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const i = argv.indexOf('--device');
const device = i === -1 ? null : argv[i + 1];
if (device && !PORTS[device]) throw new Error(`unknown device ${device} - known: ${Object.keys(PORTS).join(' ')}`);

// A1 is the Tauri WebView: one page by construction, and no tab strip to leak into.
const devices = device ? [device] : Object.keys(PORTS).filter((d) => d !== 'A1');

let closed = 0;
let ambiguous = 0;
for (const d of devices) {
  const port = PORTS[d];
  let targets;
  try {
    targets = await listTargets(port);
  } catch {
    console.log(`${d} (${port}): not answering - skipped`);
    continue;
  }
  const app = targets.filter((t) => String(t.url).includes(SITE));
  const blanks = targets.filter((t) => String(t.url).startsWith('about:blank'));
  const paths = app.map((t) => new URL(t.url).pathname);
  console.log(`${d} (${port}): ${app.length} app tab(s) [${paths.join(' ')}] + ${blanks.length} blank`);
  if (app.length > 1) ambiguous++;
  if (!dry) closed += await closeExtraAppTabs(port);
}

console.log(dry ? '\n(dry run - nothing closed)' : `\nclosed ${closed} tab(s)`);
// `exitCode` and not `process.exit()`: exiting while the close requests' sockets are still being
// torn down trips a libuv assertion on Windows and turns a successful cleanup into exit 127.
process.exitCode = ambiguous > 0 && dry ? 1 : 0;
