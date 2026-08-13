#!/usr/bin/env node
/**
 * Proves the PHONE is running the assets that were just built, and not the ones it had before.
 *
 * `bundle-id.mjs` answers this for the browsers by comparing them against the origin, which serves
 * the deployed shell. The phone cannot be checked that way: its assets are PACKAGED INTO THE APK, so
 * the origin says nothing about them, and the CD build and the local `bun run build` are two
 * different builds of the same source - their SvelteKit ids differ by construction, which makes
 * "same id as prod" the wrong question and a guaranteed false alarm.
 *
 * The right question is whether the phone serves THIS working tree's build. SvelteKit stamps one id
 * per build in `_app/version.json` and every immutable chunk hangs off that same build, so equality
 * there covers the whole tree - no minified needle to grep for, nothing that silently stops matching
 * the next time a chunk is renamed.
 *
 * The chain this closes: `git status` says frontend/ is at HEAD -> the APK was built from it -> the
 * phone serves that build's id. Run `git status` yourself; this script proves only the last link,
 * and says so rather than implying more.
 *
 *   node a1-bundle.mjs
 */
import { readFileSync } from 'node:fs';
import { client } from './chat.mjs';
import { evaluate } from './cdp.mjs';
import { PORTS } from './names.mjs';

// The rig runs from `../canari-harness` and the archived copy lives inside the repo, so the build
// output sits at a different depth depending on which copy is being run. Both are listed rather
// than assumed: a wrong guess here reports "no local build" and reads as a failed build.
const CANDIDATES = ['../canari/frontend/build/_app/version.json', '../../frontend/build/_app/version.json'];

let local, from;
for (const rel of CANDIDATES) {
  try {
    local = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')).version;
    from = rel;
    break;
  } catch {
    /* try the next one; only the last failure is worth reporting */
  }
}
if (!local) {
  console.log(`[a1-bundle] no local build at any of ${CANDIDATES.join(' or ')} - run the Android build first`);
  process.exit(2);
}
console.log(`[a1-bundle] reading ${from}`);
console.log(`[a1-bundle] built here: ${local}`);

const cx = await client(PORTS.A1, null, { focus: false });
const raw = await evaluate(
  cx,
  `fetch('http://tauri.localhost/_app/version.json', { cache: 'no-store' })
     .then(function (r) { return r.text().then(function (t) { return JSON.stringify({ status: r.status, body: t }); }); })
     .catch(function (e) { return JSON.stringify({ status: 0, body: String(e) }); })`,
  { awaitPromise: true }
);
cx.close();

const got = JSON.parse(raw);
if (got.status !== 200) {
  console.log(`[a1-bundle] the phone did not serve version.json (${got.status}): ${got.body}`);
  process.exit(2);
}
const running = JSON.parse(got.body).version;
const ok = running === local;
console.log(`[a1-bundle] on the phone: ${running} ${ok ? 'OK' : '<-- STALE, the install did not take'}`);
console.log(`[a1-bundle] ${ok ? 'A1 serves the build made from this working tree' : 'DO NOT MEASURE - A1 is on other code'}`);
process.exit(ok ? 0 : 1);
